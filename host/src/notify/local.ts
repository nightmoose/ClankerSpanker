import { execFile } from "node:child_process";
import { hostPlatform } from "../platform.js";

/**
 * Best-effort desktop notification. Never throws; host stays usable over SSH.
 * - macOS: osascript
 * - Linux: notify-send (if present)
 * - Windows: PowerShell balloon (best effort)
 * - else: log only
 */
export function notifyDesktop(title: string, message: string): void {
  const plat = hostPlatform();
  if (plat === "darwin") {
    const script = `display notification ${jsonString(message)} with title ${jsonString(title)}`;
    execFile("osascript", ["-e", script], (err) => {
      if (err) console.warn("[notify] osascript failed:", err.message);
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
