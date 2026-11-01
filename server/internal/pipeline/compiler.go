// Package pipeline compiles source dialects into a versioned, executor-neutral plan.
package pipeline

import (
	"crypto/sha256"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

const CompilerVersion = "1"

type Location struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

type Diagnostic struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Location
	JobID      string `json:"job_id,omitempty"`
	Field      string `json:"field,omitempty"`
	Suggestion string `json:"suggestion,omitempty"`
}

type Node struct {
	ID              string   `json:"id"`
	SourceID        string   `json:"source_id"`
	Title           string   `json:"title"`
	Type            string   `json:"type"`
	Stage           string   `json:"stage"`
	Instructions    string   `json:"instructions"`
	Role            string   `json:"role"`
	Owner           string   `json:"owner"`
	Needs           []string `json:"needs"`
	ArtifactSources []string `json:"artifact_sources"`
	Paths           []string `json:"paths"`
	When            string   `json:"when"`
	AllowFailure    bool     `json:"allow_failure"`
	Retry           int      `json:"retry"`
	Output          any      `json:"output,omitempty"`
	ExitCheck       any      `json:"exit_check,omitempty"`
	Location
}

type Plan struct {
	Kind            string   `json:"kind"`
	CompilerVersion string   `json:"compiler_version"`
	SourceHash      string   `json:"source_hash"`
	Stages          []string `json:"stages"`
	Nodes           []Node   `json:"nodes"`
}

type Validation struct {
	Kind         string       `json:"kind"`
	SyntaxValid  bool         `json:"syntax_valid"`
	BindingValid *bool        `json:"binding_valid"`
	Diagnostics  []Diagnostic `json:"diagnostics"`
	Plan         *Plan        `json:"plan"`
}

func Capabilities() map[string]any {
	return map[string]any{
		"schema_version": 1, "compiler_version": CompilerVersion,
		"kinds":    []string{"gitlab_yaml", "hermes_yaml"},
		"features": map[string]bool{"custom_roles": true, "custom_nodes": true, "gitlab_dag": true, "hermes_forward_chain": true, "manual_gates": true, "on_failure": true, "allow_failure": true, "retry": true, "attachment_artifacts": true, "repository_artifacts": true, "document_artifacts": true, "markdown_document_associations": true, "dialect_conversion": false, "conditional_routes": false, "rollback": false, "named_outputs": false, "artifact_globs": false, "run_only": false},
		"limits":   map[string]int{"source_bytes": 262144, "nodes": 256, "retry": 10},
	}
}

type compiler struct{ result Validation }

func (c *compiler) error(n *yaml.Node, job, field, code, message string) {
	d := Diagnostic{Code: code, Severity: "error", Message: message, JobID: job, Field: field}
	if n == nil && code == "invalid_yaml" {
		if match := regexp.MustCompile(`line (\d+)`).FindStringSubmatch(message); len(match) > 1 {
			d.Line, _ = strconv.Atoi(match[1])
			d.Column = 1
		}
	}
	if n != nil {
		d.Location = Location{n.Line, n.Column}
	}
	c.result.Diagnostics = append(c.result.Diagnostics, d)
}

func fields(n *yaml.Node) map[string]*yaml.Node {
	m := map[string]*yaml.Node{}
	if n != nil && n.Kind == yaml.MappingNode {
		for i := 0; i < len(n.Content); i += 2 {
			m[n.Content[i].Value] = n.Content[i+1]
		}
	}
	return m
}

func (c *compiler) mapping(n *yaml.Node, job, field string, allowed ...string) map[string]*yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		c.error(n, job, field, "invalid_yaml", "expected a mapping")
		return map[string]*yaml.Node{}
	}
	allow := map[string]bool{}
	for _, s := range allowed {
		allow[s] = true
	}
	for i := 0; i < len(n.Content); i += 2 {
		k := n.Content[i]
		if !allow[k.Value] {
			c.error(k, job, k.Value, "unknown_field", "unsupported field: "+k.Value)
		}
	}
	return fields(n)
}

func (c *compiler) str(n *yaml.Node, job, field string) string {
	if n == nil {
		return ""
	}
	if n.Kind != yaml.ScalarNode || n.Tag != "!!str" {
		c.error(n, job, field, "invalid_yaml", "expected a string")
		return ""
	}
	return n.Value
}
func (c *compiler) list(n *yaml.Node, job, field string) []string {
	out := []string{}
	if n == nil {
		return out
	}
	if n.Kind != yaml.SequenceNode {
		c.error(n, job, field, "invalid_yaml", "expected a string array")
		return out
	}
	seen := map[string]bool{}
	for _, v := range n.Content {
		s := c.str(v, job, field)
		if seen[s] {
			c.error(v, job, field, "duplicate_key", "duplicate reference: "+s)
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}
func (c *compiler) boolean(n *yaml.Node, job, field string) bool {
	if n == nil {
		return false
	}
	if n.Tag != "!!bool" {
		c.error(n, job, field, "invalid_yaml", "expected a boolean")
		return false
	}
	var b bool
	_ = n.Decode(&b)
	return b
}
func (c *compiler) retry(n *yaml.Node, job string) int {
	if n == nil {
		return 0
	}
	var v int
	if n.Tag != "!!int" || n.Decode(&v) != nil || v < 0 || v > 10 {
		c.error(n, job, "retry", "unsupported_capability", "retry must be an integer from 0 to 10")
		return 0
	}
	return v
}
func (c *compiler) paths(n *yaml.Node, job string) []string {
	if n == nil {
		return []string{}
	}
	f := c.mapping(n, job, "artifacts", "paths")
	p := c.list(f["paths"], job, "artifacts.paths")
	for _, s := range p {
		if s == "" || path.IsAbs(s) || path.Clean(s) != s || s == ".." || strings.HasPrefix(s, "../") || strings.ContainsAny(s, "\\*?[]\x00") {
			c.error(n, job, "artifacts.paths", "unsupported_capability", "artifacts require exact relative file paths")
		}
	}
	return p
}

func Compile(source string) Validation {
	c := &compiler{result: Validation{Kind: "gitlab_yaml", Diagnostics: []Diagnostic{}}}
	if len(source) > 262144 {
		c.error(nil, "", "", "invalid_yaml", "source exceeds 256 KiB")
		return c.result
	}
	var doc yaml.Node
	dec := yaml.NewDecoder(strings.NewReader(source))
	if err := dec.Decode(&doc); err != nil {
		c.error(nil, "", "", "invalid_yaml", err.Error())
		return c.result
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); err != io.EOF {
		c.error(nil, "", "", "invalid_yaml", "exactly one YAML document is required")
		return c.result
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		c.error(nil, "", "", "invalid_yaml", "expected a document mapping")
		return c.result
	}
	root := doc.Content[0]
	count := 0
	var walk func(*yaml.Node)
	walk = func(n *yaml.Node) {
		count++
		if count > 20000 {
			return
		}
		if n.Kind == yaml.AliasNode || n.Anchor != "" {
			c.error(n, "", "", "unsupported_capability", "YAML anchors and aliases are unsupported")
			return
		}
		if n.Kind == yaml.MappingNode {
			seen := map[string]bool{}
			for i := 0; i < len(n.Content); i += 2 {
				k := n.Content[i]
				if k.Tag != "!!str" || k.Value == "<<" {
					c.error(k, "", "", "invalid_yaml", "mapping keys must be strings")
				}
				if seen[k.Value] {
					c.error(k, "", k.Value, "duplicate_key", "duplicate key: "+k.Value)
				}
				seen[k.Value] = true
			}
		}
		for _, child := range n.Content {
			walk(child)
		}
	}
	walk(root)
	if count > 20000 {
		c.error(root, "", "", "invalid_yaml", "document is too complex")
	}
	if len(c.result.Diagnostics) > 0 {
		return c.result
	}
	if k := fields(root)["kind"]; k != nil {
		c.result.Kind = c.str(k, "", "kind")
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(source)))
	plan := &Plan{Kind: c.result.Kind, CompilerVersion: CompilerVersion, SourceHash: hash, Nodes: []Node{}, Stages: []string{}}
	switch c.result.Kind {
	case "gitlab_yaml":
		c.gitlab(root, plan)
	case "hermes_yaml":
		c.hermes(root, plan)
	default:
		c.error(fields(root)["kind"], "", "kind", "unsupported_capability", "unknown source kind")
	}
	c.checkGraph(plan)
	if len(c.result.Diagnostics) == 0 {
		c.result.SyntaxValid = true
		c.result.Plan = plan
	}
	return c.result
}

var identifier = regexp.MustCompile(`^[\pL\pN_.-]+$`)

func (c *compiler) gitlab(root *yaml.Node, p *Plan) {
	f := fields(root)
	p.Stages = c.list(f["stages"], "", "stages")
	if len(p.Stages) == 0 {
		c.error(root, "", "stages", "unknown_stage", "stages must be nonempty")
	}
	stageIndex := map[string]int{}
	for i, s := range p.Stages {
		stageIndex[s] = i
		if strings.TrimSpace(s) == "" {
			c.error(f["stages"], "", "stages", "unknown_stage", "stage names must be nonempty")
		}
	}
	for i := 0; i < len(root.Content); i += 2 {
		key, value := root.Content[i], root.Content[i+1]
		id := key.Value
		if id == "kind" || id == "stages" {
			continue
		}
		if !identifier.MatchString(id) || strings.HasPrefix(id, ".") {
			c.error(key, id, "", "unsupported_capability", "unsupported job identifier")
		}
		j := c.mapping(value, id, "", "stage", "instructions", "tags", "needs", "dependencies", "artifacts", "owner", "when", "allow_failure", "retry")
		n := Node{ID: id, SourceID: id, Title: id, Type: "agent", Stage: c.str(j["stage"], id, "stage"), Instructions: c.str(j["instructions"], id, "instructions"), Owner: c.str(j["owner"], id, "owner"), When: "on_success", AllowFailure: c.boolean(j["allow_failure"], id, "allow_failure"), Retry: c.retry(j["retry"], id), Paths: c.paths(j["artifacts"], id), Location: Location{key.Line, key.Column}}
		idx, ok := stageIndex[n.Stage]
		if !ok {
			c.error(j["stage"], id, "stage", "unknown_stage", "job stage is not in stages")
		}
		tags := c.list(j["tags"], id, "tags")
		if len(tags) > 1 {
			c.error(j["tags"], id, "tags", "unsupported_capability", "each job accepts at most one role")
		}
		if len(tags) > 0 {
			n.Role = strings.TrimSpace(tags[0])
			if n.Role == "" {
				c.error(j["tags"], id, "tags", "role_unbound", "role must be nonempty")
			}
		}
		if j["when"] != nil {
			n.When = c.str(j["when"], id, "when")
		}
		switch n.When {
		case "manual":
			n.Type = "manual"
		case "on_success", "on_failure":
		default:
			c.error(j["when"], id, "when", "unsupported_capability", "unsupported when value")
		}
		if n.Type == "agent" && strings.TrimSpace(n.Instructions) == "" {
			c.error(value, id, "instructions", "invalid_yaml", "agent instructions are required")
		}
		if n.Type == "manual" && (n.Role != "" || n.Retry != 0 || len(n.Paths) > 0) {
			c.error(value, id, "", "unsupported_capability", "manual nodes do not execute roles, retries or output files")
		}
		if j["needs"] != nil {
			n.Needs = c.list(j["needs"], id, "needs")
		} else {
			n.Needs = []string{}
			for name, v := range f {
				if name == "kind" || name == "stages" {
					continue
				}
				s := c.str(fields(v)["stage"], name, "stage")
				if k, exists := stageIndex[s]; exists && k < idx {
					n.Needs = append(n.Needs, name)
				}
			}
			sort.Strings(n.Needs)
		}
		n.ArtifactSources = append([]string{}, n.Needs...)
		if j["dependencies"] != nil {
			if j["needs"] != nil {
				c.error(j["dependencies"], id, "dependencies", "unsupported_capability", "needs and dependencies cannot be combined")
			}
			n.ArtifactSources = c.list(j["dependencies"], id, "dependencies")
		}
		p.Nodes = append(p.Nodes, n)
	}
	for _, n := range p.Nodes {
		for _, dep := range append(append([]string{}, n.Needs...), n.ArtifactSources...) {
			for _, up := range p.Nodes {
				if up.ID == dep && (stageIndex[up.Stage] > stageIndex[n.Stage] || (jHasDependencies(f[n.ID]) && stageIndex[up.Stage] >= stageIndex[n.Stage])) {
					c.error(f[n.ID], n.ID, "needs", "unsupported_capability", "dependency must refer to the same or an earlier stage; artifact dependencies must be earlier")
				}
			}
		}
	}
}
func jHasDependencies(n *yaml.Node) bool { return fields(n)["dependencies"] != nil }

func (c *compiler) hermes(root *yaml.Node, p *Plan) {
	f := c.mapping(root, "", "", "kind", "id", "name", "version", "roles", "gates", "states", "edges")
	roles := fields(f["roles"])
	if f["roles"] != nil && f["roles"].Kind != yaml.MappingNode {
		c.error(f["roles"], "", "roles", "invalid_yaml", "roles must be a mapping")
	}
	for name, n := range roles {
		c.mapping(n, "", name)
	}
	gates := fields(f["gates"])
	for id, n := range gates {
		g := c.mapping(n, id, "gate", "type", "owner")
		if c.str(g["type"], id, "type") != "manual" {
			c.error(n, id, "type", "unsupported_capability", "only manual gates are supported")
		}
	}
	states := f["states"]
	if states == nil || states.Kind != yaml.MappingNode {
		c.error(states, "", "states", "invalid_yaml", "states must be a mapping")
		return
	}
	usedGates := map[string]bool{}
	last := map[string]string{}
	for i := 0; i < len(states.Content); i += 2 {
		k, v := states.Content[i], states.Content[i+1]
		id := k.Value
		if !identifier.MatchString(id) {
			c.error(k, id, "", "invalid_yaml", "invalid state identifier")
		}
		s := c.mapping(v, id, "", "title", "by", "entry", "gate", "artifacts", "output", "exit_check", "owner", "retry", "allow_failure")
		n := Node{ID: id, SourceID: id, Title: c.str(s["title"], id, "title"), Type: "agent", Stage: id, Instructions: c.str(s["entry"], id, "entry"), Role: c.str(s["by"], id, "by"), Owner: c.str(s["owner"], id, "owner"), Needs: []string{}, ArtifactSources: []string{}, Paths: c.paths(s["artifacts"], id), When: "on_success", AllowFailure: c.boolean(s["allow_failure"], id, "allow_failure"), Retry: c.retry(s["retry"], id), Location: Location{k.Line, k.Column}}
		if n.Title == "" {
			n.Title = id
		}
		if strings.TrimSpace(n.Instructions) == "" {
			c.error(v, id, "entry", "invalid_yaml", "state entry is required")
		}
		if n.Role != "" && roles[n.Role] == nil {
			c.error(s["by"], id, "by", "role_unbound", "by must reference a declared role")
		}
		if s["output"] != nil {
			_ = s["output"].Decode(&n.Output)
		}
		if s["exit_check"] != nil {
			_ = s["exit_check"].Decode(&n.ExitCheck)
		}
		p.Nodes = append(p.Nodes, n)
		p.Stages = append(p.Stages, id)
		last[id] = id
		if s["gate"] != nil {
			gate := c.str(s["gate"], id, "gate")
			g := gates[gate]
			if g == nil || usedGates[gate] {
				c.error(s["gate"], id, "gate", "invalid_yaml", "gate must reference a unique declared manual gate")
				continue
			}
			usedGates[gate] = true
			gid := id + ".gate." + gate
			last[id] = gid
			p.Nodes = append(p.Nodes, Node{ID: gid, SourceID: id, Title: gate, Type: "manual", Stage: id, Owner: c.str(fields(g)["owner"], id, "owner"), When: "manual", Needs: []string{id}, ArtifactSources: []string{id}, Paths: []string{}, Location: Location{s["gate"].Line, s["gate"].Column}})
		}
	}
	for id, g := range gates {
		if !usedGates[id] {
			c.error(g, id, "gate", "unknown_need", "gate is not used by any state")
		}
	}
	edges := f["edges"]
	in, out := map[string]int{}, map[string]int{}
	if edges != nil && edges.Kind != yaml.SequenceNode {
		c.error(edges, "", "edges", "invalid_yaml", "edges must be an array")
	} else if edges != nil {
		for _, e := range edges.Content {
			v := c.mapping(e, "", "edges", "from", "to", "type")
			from, to, kind := c.str(v["from"], "", "from"), c.str(v["to"], "", "to"), c.str(v["type"], "", "type")
			if kind != "forward" {
				c.error(e, to, "type", "unsupported_capability", "only forward chain edges are supported")
			}
			if last[from] == "" || last[to] == "" {
				c.error(e, to, "edges", "unknown_need", "edge refers to an unknown state")
				continue
			}
			in[to]++
			out[from]++
			if in[to] > 1 || out[from] > 1 {
				c.error(e, to, "edges", "unsupported_capability", "Hermes branching and joins require conditional routing, which is unsupported")
			}
			for i := range p.Nodes {
				if p.Nodes[i].ID == to {
					p.Nodes[i].Needs = append(p.Nodes[i].Needs, last[from])
					p.Nodes[i].ArtifactSources = append(p.Nodes[i].ArtifactSources, last[from])
					if last[from] != from {
						p.Nodes[i].ArtifactSources = append(p.Nodes[i].ArtifactSources, from)
					}
				}
			}
		}
	}
	if len(last) > 1 && (edges == nil || len(edges.Content) != len(last)-1) {
		c.error(states, "", "edges", "unsupported_capability", "Hermes states must form one connected forward chain")
	}
}

func (c *compiler) checkGraph(p *Plan) {
	if len(p.Nodes) == 0 || len(p.Nodes) > 256 {
		c.error(nil, "", "", "invalid_yaml", "plan must contain 1 to 256 nodes")
	}
	byID := map[string]Node{}
	for _, n := range p.Nodes {
		if _, ok := byID[n.ID]; ok {
			c.error(nil, n.ID, "", "duplicate_key", "duplicate compiled node id")
		}
		byID[n.ID] = n
	}
	color := map[string]int{}
	var visit func(string)
	visit = func(id string) {
		if color[id] == 2 {
			return
		}
		n := byID[id]
		if color[id] == 1 {
			c.error(&yaml.Node{Line: n.Line, Column: n.Column}, id, "needs", "cyclic_dependency", "dependency cycle")
			return
		}
		color[id] = 1
		for _, dep := range n.Needs {
			if _, ok := byID[dep]; !ok {
				c.error(&yaml.Node{Line: n.Line, Column: n.Column}, id, "needs", "unknown_need", "unknown dependency: "+dep)
			} else {
				visit(dep)
			}
		}
		color[id] = 2
	}
	for _, n := range p.Nodes {
		visit(n.ID)
		for _, s := range n.ArtifactSources {
			if _, ok := byID[s]; !ok {
				c.error(&yaml.Node{Line: n.Line, Column: n.Column}, n.ID, "artifact_sources", "unknown_need", "unknown artifact source: "+s)
			}
		}
	}
}
