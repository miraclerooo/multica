package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/spf13/cobra"
)

func addDocumentAssociationCommands(group *cobra.Command) {
	associate := &cobra.Command{Use: "associate <issue-id>", Short: "Associate an existing or new Markdown document and append a pinned source link", Args: exactArgs(1), RunE: runDocumentAssociation}
	associate.Flags().String("document", "", "Existing document UUID; use with --base-version")
	associate.Flags().String("new-title", "", "Create a Markdown document in the issue's project")
	associate.Flags().String("kind", "document", "Kind for a new document: spec or document")
	associate.Flags().String("body-file", "", "Initial Markdown for a new document")
	associate.Flags().Int32("base-version", 0, "Explicit version of the existing document")
	associate.Flags().String("source-file", "", "JSON reference: attachment, document, pipeline_artifact, repository or url; omit to associate without editing the body")
	associate.Flags().String("label", "", "Markdown link label")
	associate.Flags().String("description", "", "Optional text after the link")
	associate.Flags().String("idempotency-key", "", "Stable key reused only for the same request")
	associate.Flags().String("output", "json", "Output format: json")
	_ = associate.MarkFlagRequired("idempotency-key")
	group.AddCommand(associate)
	for _, operation := range []string{"references", "unlink"} {
		op := operation
		use, argc := op+" <issue-id>", 1
		if op == "unlink" {
			use += " <document-id>"
			argc = 2
		}
		cmd := &cobra.Command{Use: use, Short: map[string]string{"references": "Query documents and pinned sources associated with an issue", "unlink": "Remove an issue association while preserving the Markdown, artifacts and revisions"}[op], Args: exactArgs(argc), RunE: func(cmd *cobra.Command, args []string) error {
			client, err := newAPIClient(cmd)
			if err != nil {
				return err
			}
			ctx, cancel := cli.APIContext(context.Background())
			defer cancel()
			path := "/api/issues/" + url.PathEscape(args[0]) + "/documents"
			if op == "unlink" {
				id, err := util.ParseUUID(args[1])
				if err != nil {
					return fmt.Errorf("document-id must be a UUID")
				}
				if err = client.DeleteJSON(ctx, path+"/"+util.UUIDToString(id)); err != nil {
					return err
				}
				return cli.PrintJSON(cmd.OutOrStdout(), map[string]any{"unlinked": true, "document_id": util.UUIDToString(id)})
			}
			var result map[string]any
			if err = client.GetJSON(ctx, path, &result); err != nil {
				return err
			}
			return cli.PrintJSON(cmd.OutOrStdout(), result)
		}}
		cmd.Flags().String("output", "json", "Output format: json")
		group.AddCommand(cmd)
	}
}

func runDocumentAssociation(cmd *cobra.Command, args []string) error {
	existing, _ := cmd.Flags().GetString("document")
	title, _ := cmd.Flags().GetString("new-title")
	if (existing == "") == (title == "") {
		return fmt.Errorf("choose --document or --new-title")
	}
	version, _ := cmd.Flags().GetInt32("base-version")
	key, _ := cmd.Flags().GetString("idempotency-key")
	if strings.TrimSpace(key) == "" {
		return fmt.Errorf("idempotency-key is required")
	}
	input := map[string]any{"base_version": version, "idempotency_key": key}
	bodyFile, _ := cmd.Flags().GetString("body-file")
	if existing != "" {
		id, err := util.ParseUUID(existing)
		if err != nil {
			return fmt.Errorf("document must be a UUID")
		}
		if version < 1 {
			return fmt.Errorf("base-version must be positive for an existing document")
		}
		if bodyFile != "" {
			return fmt.Errorf("body-file is initial content for a new document; use update for existing content")
		}
		input["document_id"] = util.UUIDToString(id)
	} else {
		if version != 0 {
			return fmt.Errorf("base-version must be zero when creating a document")
		}
		kind, _ := cmd.Flags().GetString("kind")
		if kind != "document" && kind != "spec" {
			return fmt.Errorf("kind must be spec or document")
		}
		doc := map[string]any{"title": title, "kind": kind}
		if bodyFile != "" {
			body, err := os.ReadFile(bodyFile)
			if err != nil {
				return err
			}
			doc["body"] = string(body)
		}
		input["create_document"] = doc
	}
	sourceFile, _ := cmd.Flags().GetString("source-file")
	if sourceFile != "" {
		raw, err := os.ReadFile(sourceFile)
		if err != nil {
			return err
		}
		var source map[string]any
		if err = json.Unmarshal(raw, &source); err != nil || source == nil {
			return fmt.Errorf("source-file must contain one JSON source object")
		}
		input["source"] = source
	}
	for _, name := range []string{"label", "description"} {
		v, _ := cmd.Flags().GetString(name)
		if v != "" {
			input[name] = v
		}
	}
	client, err := newAPIClient(cmd)
	if err != nil {
		return err
	}
	ctx, cancel := cli.APIContext(context.Background())
	defer cancel()
	var result map[string]any
	if err = client.PostJSON(ctx, "/api/issues/"+url.PathEscape(args[0])+"/documents", input, &result); err != nil {
		return fmt.Errorf("associate document: %w", err)
	}
	return cli.PrintJSON(cmd.OutOrStdout(), result)
}
