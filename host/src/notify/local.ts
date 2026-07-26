import { execFile } from "node:child_process";

/** Best-effort macOS notification via osascript. */
export function notifyMac(title: string, message: string): void {
  const script = `display notification ${jsonString(message)} with title ${jsonString(title)}`;
  execFile("osascript", ["-e", script], (err) => {
    if (err) {
      // Non-fatal — host still works headless / SSH
      console.warn("[notify] osascript failed:", err.message);
    }
  });
}

function jsonString(s: string): string {
  return JSON.stringify(s);
}
