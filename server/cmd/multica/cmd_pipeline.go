package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/spf13/cobra"
)

func init() { rootCmd.AddCommand(newPipelineCommand()) }

func newPipelineCommand() *cobra.Command {
	root := &cobra.Command{Use: "pipeline", Short: "Compile, version and run squad pipelines"}
	root.PersistentFlags().String("output", "json", "Output format: json (or yaml for definition get)")
	add := func(parent *cobra.Command, use, op string, n int) *cobra.Command {
		cmd := &cobra.Command{Use: use, Short: op, Args: exactArgs(n), RunE: func(cmd *cobra.Command, args []string) error {
			return pipelineCommandError(cmd, runPipeline(cmd, args, op))
		}}
		parent.AddCommand(cmd)
		return cmd
	}
	add(root, "capabilities", "capabilities", 0)
	validate := add(root, "validate <file|->", "validate", 1)
	validate.Flags().String("squad", "", "Check the referenced roles in this squad")
	create := add(root, "create <file|->", "create", 1)
	create.Flags().String("squad", "", "Owning squad ID (required)")
	create.Flags().String("idempotency-key", "", "Idempotency key (required)")
	_ = create.MarkFlagRequired("squad")
	_ = create.MarkFlagRequired("idempotency-key")
	add(root, "get <definition-id>", "get", 1)
	list := add(root, "list", "list", 0)
	list.Flags().String("squad", "", "Owning squad ID (required)")
	_ = list.MarkFlagRequired("squad")
	pipelinePageFlags(list)
	runs := &cobra.Command{Use: "run", Short: "Work with persistent pipeline runs"}
	root.AddCommand(runs)
	runCreate := add(runs, "create", "run create", 0)
	for _, flag := range []string{"issue", "squad", "definition", "idempotency-key"} {
		runCreate.Flags().String(flag, "", flag)
	}
	for _, f := range []string{"issue", "squad", "idempotency-key"} {
		_ = runCreate.MarkFlagRequired(f)
	}
	runList := add(runs, "list", "run list", 0)
	runList.Flags().String("issue", "", "Filter by issue ID or identifier")
	runList.Flags().String("squad", "", "Filter by squad ID")
	pipelinePageFlags(runList)
	add(runs, "get <run-id>", "run get", 1)
	cancel := add(runs, "cancel <run-id>", "run cancel", 1)
	cancel.Flags().String("reason", "", "Cancellation reason (required)")
	cancel.Flags().String("idempotency-key", "", "Idempotency key (required)")
	_ = cancel.MarkFlagRequired("reason")
	_ = cancel.MarkFlagRequired("idempotency-key")
	jobs := &cobra.Command{Use: "job", Short: "Read attempts, report results and decide manual gates"}
	root.AddCommand(jobs)
	add(jobs, "get <run-id> <job-id>", "job get", 2)
	logs := add(jobs, "logs <run-id> <job-id>", "job logs", 2)
	logs.Flags().Int("attempt", 0, "Attempt number; defaults to current")
	pipelinePageFlags(logs)
	for _, op := range []string{"retry", "approve", "reject"} {
		cmd := add(jobs, op+" <run-id> <job-id>", "job "+op, 2)
		cmd.Flags().Int64("expected-revision", 0, "Node revision read from job get (required)")
		cmd.Flags().String("idempotency-key", "", "Idempotency key (required)")
		_ = cmd.MarkFlagRequired("expected-revision")
		_ = cmd.MarkFlagRequired("idempotency-key")
		if op == "reject" {
			cmd.Flags().String("reason-file", "", "UTF-8 rejection reason (required)")
			_ = cmd.MarkFlagRequired("reason-file")
		}
	}
	report := add(jobs, "report <run-id> <job-id>", "job report", 2)
	report.Flags().Int("attempt", 0, "Current attempt number (required)")
	report.Flags().String("result", "", "succeeded, failed or blocked (required)")
	report.Flags().String("report-file", "", "UTF-8 report (required)")
	report.Flags().String("artifacts-file", "", "JSON array of {path,attachment_id} references published by this task")
	report.Flags().String("idempotency-key", "", "Idempotency key (required)")
	for _, f := range []string{"attempt", "result", "report-file", "idempotency-key"} {
		_ = report.MarkFlagRequired(f)
	}
	artifacts := &cobra.Command{Use: "artifact", Short: "Inspect declarations and published artifacts"}
	root.AddCommand(artifacts)
	al := add(artifacts, "list <run-id>", "artifact list", 1)
	al.Flags().String("job", "", "Filter by job ID")
	pipelinePageFlags(al)
	dl := add(artifacts, "download <artifact-id>", "artifact download", 1)
	dl.Flags().String("output-dir", ".", "Destination directory")
	return root
}
func pipelinePageFlags(cmd *cobra.Command) {
	cmd.Flags().Int("limit", 50, "Page size (1-100)")
	cmd.Flags().Int("offset", 0, "Page offset")
}
func pipelineFlag(cmd *cobra.Command, name string) string {
	v, _ := cmd.Flags().GetString(name)
	return v
}
func pipelineFile(cmd *cobra.Command, path string) (string, error) {
	if path == "-" {
		b, e := io.ReadAll(io.LimitReader(cmd.InOrStdin(), 1048577))
		if len(b) > 1048576 {
			return "", fmt.Errorf("input exceeds 1 MiB")
		}
		return string(b), e
	}
	b, e := os.ReadFile(path)
	return string(b), e
}

func runPipeline(cmd *cobra.Command, args []string, op string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	endpoint := ""
	method := "GET"
	var body any
	q := url.Values{}
	if cmd.Flags().Lookup("limit") != nil {
		n, _ := cmd.Flags().GetInt("limit")
		o, _ := cmd.Flags().GetInt("offset")
		q.Set("limit", strconv.Itoa(n))
		q.Set("offset", strconv.Itoa(o))
	}
	if strings.HasPrefix(op, "job ") {
		endpoint = "/api/pipeline-runs/" + url.PathEscape(args[0]) + "/jobs/" + url.PathEscape(args[1])
	}
	switch op {
	case "capabilities":
		endpoint = "/api/pipelines/capabilities"
	case "validate", "create":
		source, e := pipelineFile(cmd, args[0])
		if e != nil {
			return e
		}
		endpoint = "/api/pipelines/validate"
		method = "POST"
		payload := map[string]any{"source": source}
		if id := pipelineFlag(cmd, "squad"); id != "" {
			payload["squad_id"] = id
		}
		if op == "create" {
			endpoint = "/api/pipelines/definitions"
			payload["idempotency_key"] = pipelineFlag(cmd, "idempotency-key")
		}
		body = payload
	case "get":
		endpoint = "/api/pipelines/definitions/" + url.PathEscape(args[0])
	case "list":
		endpoint = "/api/pipelines/definitions"
		q.Set("squad_id", pipelineFlag(cmd, "squad"))
	case "run create":
		endpoint = "/api/pipeline-runs"
		method = "POST"
		body = map[string]any{"issue_id": pipelineFlag(cmd, "issue"), "squad_id": pipelineFlag(cmd, "squad"), "definition_id": pipelineFlag(cmd, "definition"), "idempotency_key": pipelineFlag(cmd, "idempotency-key")}
	case "run list":
		endpoint = "/api/pipeline-runs"
		for _, k := range []string{"issue", "squad"} {
			if v := pipelineFlag(cmd, k); v != "" {
				q.Set(k+"_id", v)
			}
		}
	case "run get":
		endpoint = "/api/pipeline-runs/" + url.PathEscape(args[0])
	case "run cancel":
		endpoint = "/api/pipeline-runs/" + url.PathEscape(args[0]) + "/cancel"
		method = "POST"
		body = map[string]any{"reason": pipelineFlag(cmd, "reason"), "idempotency_key": pipelineFlag(cmd, "idempotency-key")}
	case "job get":
	case "job logs":
		var job pipeline.Job
		if e := client.GetJSON(ctx, endpoint, &job); e != nil {
			return e
		}
		attempt, _ := cmd.Flags().GetInt("attempt")
		if attempt == 0 {
			attempt = len(job.Attempts)
		}
		if attempt < 1 || attempt > len(job.Attempts) {
			return fmt.Errorf("attempt not found")
		}
		endpoint = "/api/tasks/" + url.PathEscape(job.Attempts[attempt-1].TaskID) + "/messages"
	case "job retry", "job approve", "job reject":
		rev, _ := cmd.Flags().GetInt64("expected-revision")
		payload := map[string]any{"expected_revision": rev, "idempotency_key": pipelineFlag(cmd, "idempotency-key")}
		method = "POST"
		if op == "job retry" {
			endpoint += "/retry"
		} else {
			endpoint += "/decisions"
			payload["decision"] = "approve"
			if op == "job reject" {
				payload["decision"] = "reject"
				reason, e := pipelineFile(cmd, pipelineFlag(cmd, "reason-file"))
				if e != nil {
					return e
				}
				payload["reason"] = reason
			}
		}
		body = payload
	case "job report":
		method = "POST"
		endpoint += "/report"
		report, e := pipelineFile(cmd, pipelineFlag(cmd, "report-file"))
		if e != nil {
			return e
		}
		attempt, _ := cmd.Flags().GetInt("attempt")
		artifacts := []pipeline.Artifact{}
		if file := pipelineFlag(cmd, "artifacts-file"); file != "" {
			data, e := os.ReadFile(file)
			if e != nil {
				return e
			}
			if e = json.Unmarshal(data, &artifacts); e != nil {
				return e
			}
		}
		body = map[string]any{"attempt": attempt, "result": pipelineFlag(cmd, "result"), "report": report, "artifacts": artifacts, "idempotency_key": pipelineFlag(cmd, "idempotency-key")}
	case "artifact list":
		endpoint = "/api/pipeline-runs/" + url.PathEscape(args[0]) + "/artifacts"
		if j := pipelineFlag(cmd, "job"); j != "" {
			q.Set("job_id", j)
		}
	case "artifact download":
		return downloadPipelineArtifact(ctx, cmd, client, args[0])
	default:
		return fmt.Errorf("unknown pipeline operation")
	}
	if len(q) > 0 {
		endpoint += "?" + q.Encode()
	}
	var raw json.RawMessage
	if method == "POST" {
		err = client.PostJSON(ctx, endpoint, body, &raw)
	} else {
		err = client.GetJSON(ctx, endpoint, &raw)
	}
	if err != nil {
		return err
	}
	if op == "get" && pipelineFlag(cmd, "output") == "yaml" {
		var d struct {
			Source string `json:"source"`
		}
		if err = json.Unmarshal(raw, &d); err != nil {
			return err
		}
		_, err = fmt.Fprint(cmd.OutOrStdout(), d.Source)
		return err
	}
	if err = cli.PrintJSON(cmd.OutOrStdout(), raw); err != nil {
		return err
	}
	if op == "validate" {
		var v pipeline.Validation
		if err = json.Unmarshal(raw, &v); err != nil {
			return err
		}
		if !v.SyntaxValid || (v.BindingValid != nil && !*v.BindingValid) {
			return fmt.Errorf("pipeline validation failed")
		}
	}
	return nil
}

func downloadPipelineArtifact(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, id string) error {
	parts := strings.SplitN(id, "/", 4)
	if len(parts) != 4 {
		return fmt.Errorf("artifact ID must be copied from artifact list")
	}
	var run pipeline.Run
	if err := client.GetJSON(ctx, "/api/pipeline-runs/"+url.PathEscape(parts[0]), &run); err != nil {
		return err
	}
	for _, a := range run.Artifacts() {
		if a.ID != id {
			continue
		}
		if a.Status != "accessible" {
			return fmt.Errorf("artifact_unavailable: artifact has no accessible published attachment")
		}
		data, err := client.DownloadFile(ctx, "/api/pipeline-runs/"+url.PathEscape(run.ID)+"/artifact-content?artifact_id="+url.QueryEscape(a.ID))
		if err != nil {
			return err
		}
		dir := pipelineFlag(cmd, "output-dir")
		if err = os.MkdirAll(dir, 0755); err != nil {
			return err
		}
		dest := filepath.Join(dir, filepath.Base(a.Path))
		file, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			return err
		}
		_, err = file.Write(data)
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"id": id, "path": dest, "size": len(data)})
	}
	return fmt.Errorf("artifact not found")
}

func pipelineCommandError(cmd *cobra.Command, err error) error {
	if err == nil || pipelineFlag(cmd, "output") != "json" {
		return err
	}
	var httpError *cli.HTTPError
	if errors.As(err, &httpError) {
		var body map[string]any
		if json.Unmarshal([]byte(httpError.Body), &body) == nil {
			if _, ok := body["code"]; ok {
				_ = cli.PrintJSON(cmd.ErrOrStderr(), body)
				return errSilent
			}
		}
	}
	_ = cli.PrintJSON(cmd.ErrOrStderr(), map[string]any{"code": "pipeline_command_failed", "error": err.Error()})
	return errSilent
}
