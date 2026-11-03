import { useEffect, useRef } from "react";
import { JUMP_FOLLOW_MS } from "./use-jump-to-latest";

// Initialize an ordinary visit once. Explicit navigation and reader input own
// the viewport; later comments never restart this initialization.
export function useIssueInitialLatest({
  issueKey,
  element,
  ready,
  enabled,
  jump,
  cancel,
}: {
  issueKey: string;
  element: HTMLElement | null;
  ready: boolean;
  enabled: boolean;
  jump: () => void;
  cancel: () => void;
}) {
  const started = useRef<string | null>(null),
    readerInput = useRef(false);
  useEffect(() => {
    readerInput.current = false;
    if (!element) return;
    const stop = () => {
      readerInput.current = true;
      cancel();
    };
    for (const type of ["wheel", "pointerdown", "touchstart"])
      element.addEventListener(type, stop, { passive: true });
    element.ownerDocument.addEventListener("keydown", stop, true);
    return () => {
      for (const type of ["wheel", "pointerdown", "touchstart"])
        element.removeEventListener(type, stop);
      element.ownerDocument.removeEventListener("keydown", stop, true);
    };
  }, [issueKey, element, cancel]);
  useEffect(() => {
    if (
      !element ||
      !ready ||
      !enabled ||
      readerInput.current ||
      started.current === issueKey
    )
      return;
    started.current = issueKey;
    jump();
    // Remember images in the first materialized rows. Their network requests
    // may finish after the virtual-list settling window; loading one can grow
    // an earlier row and move the latest entry out of view. Newly appended
    // comments are outside this initial set.
    const images = new Set<HTMLImageElement>();
    const collect = () =>
      element.querySelectorAll("img").forEach((img) => {
        if (!img.complete) images.add(img);
      });
    collect();
    const observer =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(collect);
    observer?.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    const stopCollecting = window.setTimeout(
      () => observer?.disconnect(),
      JUMP_FOLLOW_MS,
    );
    const loaded = (event: Event) => {
      const image = event.target;
      if (
        image instanceof HTMLImageElement &&
        images.delete(image) &&
        !readerInput.current
      )
        jump();
    };
    element.addEventListener("load", loaded, true);
    element.addEventListener("error", loaded, true);
    return () => {
      cancel();
      observer?.disconnect();
      window.clearTimeout(stopCollecting);
      element.removeEventListener("load", loaded, true);
      element.removeEventListener("error", loaded, true);
    };
  }, [issueKey, element, ready, enabled, jump, cancel]);
}
