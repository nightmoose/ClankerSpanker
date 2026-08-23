import { execFile } from "node:child_process";
import { hostPlatform } from "../platform.js";

/**
 * Best-effort desktop notification. Never throws; host stays usable over SSH.
 * - macOS: osascript
 * - Linux: notify-send (if present)
 * - Windows: PowerShell balloon (best effort)
 * - else: log only
 */
/**
 * macOS bundle ID we want desktop notifications attributed to. A bare
 * `osascript -e 'display notification ...'` gets attributed to Script Editor
 * (that's who's running the script) so clicking the banner opens Script
 * Editor instead of ClankerSpanker. Running the same command inside a
 * `tell application id "…" to …` block attributes it to that app and makes
 * clicks open ClankerSpanker Mac.
 */
const MAC_APP_BUNDLE_ID = "com.nightmoose.clankerspanker.mac";

export function notifyDesktop(title: string, message: string): void {
  const plat = hostPlatform();
  if (plat === "darwin") {
    const escapedTitle = jsonString(title);
    const escapedMessage = jsonString(message);
    const script =
      `tell application id ${jsonString(MAC_APP_BUNDLE_ID)} ` +
      `to display notification ${escapedMessage} with title ${escapedTitle}`;
    execFile("osascript", ["-e", script], (err) => {
      if (!err) return;
      // ClankerSpanker Mac isn't registered with Launch Services (fresh
      // machine, or CLI-only host). Fall back to the bare notification —
      // banner will be attributed to Script Editor, which is ugly but at
      // least the user gets notified.
      const fallback = `display notification ${escapedMessage} with title ${escapedTitle}`;
      execFile("osascript", ["-e", fallback], (err2) => {
        if (err2) console.warn("[notify] osascript failed:", err2.message);
      });
    });
    return;
  }
  if (plat === "linux") {
    execFile("notify-send", ["--app-name=ClankerSpanker", title, message], (err) => {
      if (err) console.warn("[notify] notify-send failed:", err.message);
    });
    return;
  }
  if (plat === "win32") {
    const ps = `
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
      $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
      $text = $template.GetElementsByTagName('text')
      $text.Item(0).AppendChild($template.CreateTextNode(${jsonString(title)})) | Out-Null
      $text.Item(1).AppendChild($template.CreateTextNode(${jsonString(message)})) | Out-Null
      $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ClankerSpanker').Show($toast)
    `.replace(/\n/g, " ");
    execFile("powershell.exe", ["-NoProfile", "-Command", ps], (err) => {
      if (err) console.warn("[notify] windows toast failed:", err.message);
    });
    return;
  }
  console.log(`[notify] ${title}: ${message}`);
}

/** @deprecated Use notifyDesktop — kept for call-site clarity during rename. */
export const notifyMac = notifyDesktop;

function jsonString(s: string): string {
  return JSON.stringify(s);
}
