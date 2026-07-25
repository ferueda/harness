import type { TriageWorkItemContext, TriageWorkItemReference } from "../triage/schema.ts";
import type {
  LinearCommentActor,
  LinearIssueContext,
  LinearIssueReference,
} from "../linear/types.ts";

export function toLinearWorkItemContext(
  context: LinearIssueContext,
  agentReadyLabelId: string,
): TriageWorkItemContext {
  return {
    id: context.id,
    reference: context.identifier,
    title: context.title,
    description: context.description,
    url: context.url,
    state: context.state.name,
    labels: context.labels
      .filter((label) => label.id !== agentReadyLabelId)
      .map((label) => label.name),
    comments: context.comments.map((comment) => ({
      author: commentAuthor(comment.author),
      body: comment.body,
      createdAt: comment.createdAt,
    })),
    parent: context.parent ? toWorkItemReference(context.parent) : null,
    children: context.children.map(toWorkItemReference),
    duplicateOf: context.duplicateOf ? toWorkItemReference(context.duplicateOf) : null,
    blockedBy: context.blockedBy.map(toWorkItemReference),
    related: context.related.map(toWorkItemReference),
    links: context.attachments.map((attachment) => ({
      title: attachment.title,
      url: attachment.url,
    })),
    createdAt: context.createdAt,
    updatedAt: context.updatedAt,
    completeness: {
      commentsTruncated: context.completeness.commentsTruncated,
      labelsTruncated: context.completeness.labelsTruncated,
      relationsTruncated: context.completeness.relationsTruncated,
      linksTruncated: context.completeness.attachmentsTruncated,
      childrenTruncated: context.completeness.childrenTruncated,
    },
  };
}

function toWorkItemReference(reference: LinearIssueReference): TriageWorkItemReference {
  return {
    id: reference.id,
    reference: reference.identifier,
    title: reference.title,
    url: reference.url,
    state: reference.state.name,
  };
}

function commentAuthor(author: LinearCommentActor): string | null {
  if (!author) return null;
  if (author.kind === "user") return author.displayName;
  if (author.kind === "bot") return author.name;
  return author.id;
}
