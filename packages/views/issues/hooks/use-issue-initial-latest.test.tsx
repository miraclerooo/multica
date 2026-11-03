import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { useIssueInitialLatest } from "./use-issue-initial-latest";
const jump = vi.fn(),
  cancel = vi.fn();
function Harness({
  issueKey = "a",
  ready = true,
  enabled = true,
}: {
  issueKey?: string;
  ready?: boolean;
  enabled?: boolean;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useIssueInitialLatest({ issueKey, element, ready, enabled, jump, cancel });
  return (
    <div ref={setElement} data-testid="scroller">
      <img src="/pending-evidence.png" alt="Pending evidence" />
    </div>
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("waits for the initial timeline, initializes each ordinary issue once and ignores later rerenders", () => {
  const view = render(<Harness ready={false} />);
  expect(jump).not.toHaveBeenCalled();
  view.rerender(<Harness />);
  expect(jump).toHaveBeenCalledTimes(1);
  view.rerender(<Harness />);
  expect(jump).toHaveBeenCalledTimes(1);
  view.rerender(<Harness issueKey="b" />);
  expect(jump).toHaveBeenCalledTimes(2);
});
it("leaves explicit targets and search-owned views alone", () => {
  const view = render(<Harness enabled={false} />);
  expect(jump).not.toHaveBeenCalled();
  view.rerender(<Harness />);
  expect(jump).toHaveBeenCalledTimes(1);
  view.rerender(<Harness enabled={false} />);
  view.rerender(<Harness />);
  expect(jump).toHaveBeenCalledTimes(1);
});
it("respects reader input before the first timeline batch arrives", () => {
  const view = render(<Harness ready={false} />);
  fireEvent.wheel(view.getByTestId("scroller"));
  view.rerender(<Harness />);
  expect(jump).not.toHaveBeenCalled();
});
it("follows a pending initial image once, but stops as soon as the reader takes control", () => {
  const view = render(<Harness />);
  expect(jump).toHaveBeenCalledTimes(1);
  fireEvent.load(view.getByAltText("Pending evidence"));
  expect(jump).toHaveBeenCalledTimes(2);
  view.rerender(<Harness issueKey="b" />);
  expect(jump).toHaveBeenCalledTimes(3);
  fireEvent.wheel(view.getByTestId("scroller"));
  fireEvent.load(view.getByAltText("Pending evidence"));
  expect(jump).toHaveBeenCalledTimes(3);
});
