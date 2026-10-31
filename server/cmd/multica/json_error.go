package main

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

const jsonErrorCodeAnnotation = "multica-json-error-code"

// Only the pipeline, project document and squad update commands opt into this
// contract. Other commands retain their existing human-readable error output.
func commandJSONErrorCode(cmd *cobra.Command, args []string) (string, bool) {
	code := ""
	for ancestor := cmd; ancestor != nil; ancestor = ancestor.Parent() {
		if code = ancestor.Annotations[jsonErrorCodeAnnotation]; code != "" {
			break
		}
	}
	if code == "" {
		return "", false
	}
	output := ""
	if flag := cmd.Flag("output"); flag != nil {
		output = flag.Value.String()
	}
	// A flag error may stop Cobra before a later --output=json is parsed.
	// Honor that request without treating flag values or positional files as flags.
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if !strings.HasPrefix(arg, "--") {
			continue
		}
		name, value, hasValue := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
		if name == "output" {
			if hasValue {
				output = value
			} else if i+1 < len(args) {
				i++
				output = args[i]
			}
		} else if flag := cmd.Flag(name); flag != nil && !hasValue && flag.NoOptDefVal == "" {
			i++
		}
	}
	return code, output == "json"
}

func printCommandJSONError(cmd *cobra.Command, err error, args []string) bool {
	if err == nil {
		return false
	}
	code, enabled := commandJSONErrorCode(cmd, args)
	if !enabled {
		return false
	}
	payload := map[string]json.RawMessage{}
	var httpError *cli.HTTPError
	if errors.As(err, &httpError) {
		if json.Unmarshal([]byte(httpError.Body), &payload) != nil || payload == nil {
			payload = map[string]json.RawMessage{}
		}
	}
	if _, ok := payload["code"]; !ok {
		payload["code"], _ = json.Marshal(code)
	}
	if _, ok := payload["error"]; !ok {
		payload["error"], _ = json.Marshal(err.Error())
	}
	// RawMessage keeps every API field, including exact int64 revisions and the
	// latest Markdown snapshot. Error formatting must not change the error chain.
	_ = cli.PrintJSON(cmd.ErrOrStderr(), payload)
	return true
}
