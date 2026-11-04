package main

import (
	"context"
	"fmt"
	"io"
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
	group := &cobra.Command{
		Use: "document", Short: "Manage project Specs & Docs",
		Long:        "Create, read, update and delete Markdown documents in a specified project.\nProjects accept a UUID or unique ID prefix. Document references accept a UUID or multica:// URI.\nUpdates and deletions require the version you read; stale writes return a conflict.\nDeleting removes a document from active project materials while preserving immutable revisions.",
		Example:     "  multica project document create <project-id> --title 'Plan' --body 'Initial plan'\n  multica project document list <project-id>\n  multica project document get <project-id> <document-id> --output markdown\n  multica project document update <project-id> <document-id> --base-version 1 --body-file plan.md\n  multica project document delete <project-id> <document-id> --base-version 2",
		Annotations: map[string]string{jsonErrorCodeAnnotation: "command_failed"},
	}
	for _, operation := range []string{"list", "get", "history", "sources", "create", "update", "delete"} {
		op := operation
		use := op + " <project>"
		args := 1
		if op == "get" || op == "history" || op == "sources" || op == "update" || op == "delete" {
			use += " <document-id-or-uri>"
			args = 2
		}
		cmd := &cobra.Command{Use: use, Short: map[string]string{
			"list": "Discover the project's saved documents", "get": "Read the latest saved document", "history": "Read immutable revisions", "sources": "Read pinned source metadata", "create": "Create a document and attach its project resource", "update": "Save a revision against an explicit base version",
			"delete": "Remove a document from active project materials; preserve immutable revisions",
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
			cmd.Flags().String("title", "", "Document title (required for create; omitted updates preserve it)")
			cmd.Flags().String("body", "", "Markdown body, preserved verbatim; use an empty string to clear it")
			cmd.Flags().String("body-file", "", "UTF-8 Markdown file, or - to read standard input")
			cmd.MarkFlagsMutuallyExclusive("body", "body-file")
		}
		if op == "create" {
			_ = cmd.MarkFlagRequired("title")
			cmd.Flags().String("kind", "document", "spec (lightweight template) or document (blank)")
		}
		if op == "update" || op == "delete" {
			cmd.Flags().Int32("base-version", 0, "Version you read and compared; a stale version returns 409")
			_ = cmd.MarkFlagRequired("base-version")
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
	output, _ := cmd.Flags().GetString("output")
	if output != "json" && output != "table" && !(output == "markdown" && op == "get") {
		return fmt.Errorf("output must be json or table, or markdown for get")
	}
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
	var documentID string
	if len(args) == 2 {
		id, err := projectDocumentID(project.ID, args[1])
		if err != nil {
			return err
		}
		path += "/" + id
		documentID = id
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
		if cmd.Flags().Changed("title") && strings.TrimSpace(title) == "" {
			return fmt.Errorf("title must not be blank")
		}
		body, bodyErr := projectDocumentBody(cmd)
		if bodyErr != nil {
			return bodyErr
		}
		input := map[string]any{"title": title}
		if body != nil {
			input["body"] = *body
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
			if !cmd.Flags().Changed("title") && body == nil {
				return fmt.Errorf("provide --title, --body or --body-file to update")
			}
			if !cmd.Flags().Changed("title") || body == nil {
				var base struct {
					Title   *string `json:"title"`
					Body    *string `json:"body"`
					Version int32   `json:"version"`
				}
				if err := client.GetJSON(ctx, fmt.Sprintf("%s/revisions/%d", path, version), &base); err != nil {
					return fmt.Errorf("read base revision: %w", err)
				}
				if base.Title == nil || base.Body == nil || base.Version != version {
					return fmt.Errorf("invalid base revision response; document was not updated")
				}
				if !cmd.Flags().Changed("title") {
					input["title"] = *base.Title
				}
				if body == nil {
					input["body"] = *base.Body
				}
			}
			input["base_version"] = version
			err = client.PutJSON(ctx, path, input, &result)
		}
	case "delete":
		version, _ := cmd.Flags().GetInt32("base-version")
		if version < 1 {
			return fmt.Errorf("base-version must be positive")
		}
		err = client.DeleteJSONWithBody(ctx, path, map[string]any{"base_version": version})
		result = map[string]any{"id": documentID, "project_id": project.ID, "deleted": true}
	default:
		err = client.GetJSON(ctx, path, &result)
	}
	if err != nil {
		return fmt.Errorf("%s document: %w", op, err)
	}
	if op == "delete" && output == "table" {
		_, err := fmt.Fprintf(cmd.OutOrStdout(), "Deleted document %s from project %s\n", documentID, project.ID)
		return err
	}
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

func projectDocumentBody(cmd *cobra.Command) (*string, error) {
	if cmd.Flags().Changed("body") {
		body, _ := cmd.Flags().GetString("body")
		return &body, nil
	}
	if !cmd.Flags().Changed("body-file") {
		return nil, nil
	}
	file, _ := cmd.Flags().GetString("body-file")
	var data []byte
	var err error
	if file == "-" {
		data, err = io.ReadAll(cmd.InOrStdin())
	} else if file == "" {
		return nil, fmt.Errorf("body-file must name a file or - for standard input")
	} else {
		data, err = os.ReadFile(file)
	}
	if err != nil {
		return nil, fmt.Errorf("read document: %w", err)
	}
	body := string(data)
	return &body, nil
}
