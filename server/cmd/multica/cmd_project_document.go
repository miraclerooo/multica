package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/spf13/cobra"
)

func init() {
	projectCmd.AddCommand(newProjectDocumentCommand())
}

func newProjectDocumentCommand() *cobra.Command {
	group := &cobra.Command{Use: "document", Short: "Read and maintain project Specs & Docs"}
	for _, operation := range []string{"list", "get", "history", "sources", "create", "update"} {
		op := operation
		use := op + " <project-id>"
		args := 1
		if op == "get" || op == "history" || op == "sources" || op == "update" {
			use += " <document-id-or-uri>"
			args = 2
		}
		cmd := &cobra.Command{Use: use, Short: map[string]string{
			"list": "Discover the project's saved documents", "get": "Read the latest saved document", "history": "Read immutable revisions", "sources": "Read pinned source metadata", "create": "Create a document and attach its project resource", "update": "Save a revision against an explicit base version",
		}[op], Args: exactArgs(args), RunE: func(cmd *cobra.Command, args []string) error { return runProjectDocument(cmd, args, op) }}
		cmd.Flags().String("output", "json", "Output format: json, table, or markdown (get only)")
		if op == "list" {
			cmd.Flags().String("issue", "", "Filter by stable source issue ID or identifier")
			cmd.Flags().String("search", "", "Search issue identifier/title or Markdown title/body")
		}
		if op == "get" {
			cmd.Flags().Int32("version", 0, "Read a fixed immutable revision instead of latest")
		}
		if op == "create" || op == "update" {
			cmd.Flags().String("title", "", "Document title (required)")
			cmd.Flags().String("body-file", "", "UTF-8 Markdown file (required for update)")
			_ = cmd.MarkFlagRequired("title")
		}
		if op == "create" {
			cmd.Flags().String("kind", "document", "spec (lightweight template) or document (blank)")
		}
		if op == "update" {
			cmd.Flags().Int32("base-version", 0, "Version you read and compared; a stale version returns 409")
			_ = cmd.MarkFlagRequired("base-version")
			_ = cmd.MarkFlagRequired("body-file")
		}
		group.AddCommand(cmd)
	}
	addDocumentAssociationCommands(group)
	return group
}

func projectDocumentID(projectID, reference string) (string, error) {
	id := reference
	if strings.HasPrefix(reference, "multica:") {
		ref, err := url.Parse(reference)
		if err != nil {
			return "", fmt.Errorf("invalid document URI")
		}
		parts := strings.Split(strings.Trim(ref.Path, "/"), "/")
		if ref.Scheme != "multica" || ref.Host != "project" || len(parts) != 3 || parts[0] != projectID || parts[1] != "documents" || ref.RawQuery != "" {
			return "", fmt.Errorf("document URI must belong to project %s", projectID)
		}
		id = parts[2]
	}
	parsed, err := util.ParseUUID(id)
	if err != nil {
		return "", fmt.Errorf("document id must be a UUID or multica://project/<project-id>/documents/<document-id>")
	}
	return util.UUIDToString(parsed), nil
}

func runProjectDocument(cmd *cobra.Command, args []string, op string) error {
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	project, err := resolveProjectID(ctx, client, args[0])
	if err != nil {
		return fmt.Errorf("resolve project: %w", err)
	}
	path := "/api/projects/" + project.ID + "/documents"
	if len(args) == 2 {
		id, err := projectDocumentID(project.ID, args[1])
		if err != nil {
			return err
		}
		path += "/" + id
	}
	if op == "history" {
		path += "/revisions"
	}
	if op == "sources" {
		path += "/sources"
	}
	if op == "get" {
		version, _ := cmd.Flags().GetInt32("version")
		if version < 0 {
			return fmt.Errorf("version must be positive")
		}
		if version > 0 {
			path += fmt.Sprintf("/revisions/%d", version)
		}
	}
	if op == "list" {
		query := url.Values{}
		if issue, _ := cmd.Flags().GetString("issue"); issue != "" {
			query.Set("issue_id", issue)
		}
		if search, _ := cmd.Flags().GetString("search"); search != "" {
			query.Set("q", search)
		}
		if len(query) > 0 {
			path += "?" + query.Encode()
		}
	}
	var result map[string]any
	switch op {
	case "create", "update":
		title, _ := cmd.Flags().GetString("title")
		if strings.TrimSpace(title) == "" {
			return fmt.Errorf("title must not be blank")
		}
		input := map[string]any{"title": title}
		bodyFile, _ := cmd.Flags().GetString("body-file")
		if bodyFile != "" {
			body, err := os.ReadFile(bodyFile)
			if err != nil {
				return fmt.Errorf("read document: %w", err)
			}
			input["body"] = string(body)
		}
		if op == "create" {
			kind, _ := cmd.Flags().GetString("kind")
			if kind != "spec" && kind != "document" {
				return fmt.Errorf("kind must be spec or document")
			}
			input["kind"] = kind
			err = client.PostJSON(ctx, path, input, &result)
		} else {
			version, _ := cmd.Flags().GetInt32("base-version")
			if version < 1 {
				return fmt.Errorf("base-version must be positive")
			}
			if bodyFile == "" {
				return fmt.Errorf("body-file is required")
			}
			input["base_version"] = version
			err = client.PutJSON(ctx, path, input, &result)
		}
	default:
		err = client.GetJSON(ctx, path, &result)
	}
	if err != nil {
		return fmt.Errorf("%s document: %w", op, err)
	}
	output, _ := cmd.Flags().GetString("output")
	if output == "markdown" && op == "get" {
		_, err := fmt.Fprintf(cmd.OutOrStdout(), "# %s\n\n%s\n", strVal(result, "title"), strVal(result, "body"))
		return err
	}
	if output == "table" {
		key := "documents"
		if op == "history" {
			key = "revisions"
		}
		items, _ := result[key].([]any)
		if items == nil {
			items = []any{result}
		}
		rows := make([][]string, 0, len(items))
		for _, item := range items {
			if d, ok := item.(map[string]any); ok {
				rows = append(rows, []string{strVal(d, "id"), strVal(d, "title"), fmt.Sprint(d["version"]), strVal(d, "author_type"), strVal(d, "author_name")})
			}
		}
		cli.PrintTable(cmd.OutOrStdout(), []string{"ID", "TITLE", "VERSION", "AUTHOR TYPE", "AUTHOR"}, rows)
		return nil
	}
	return cli.PrintJSON(cmd.OutOrStdout(), result)
}
