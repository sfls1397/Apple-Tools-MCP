#!/usr/bin/env node
/**
 * Print-only reminder after npm install / upgrade.
 *
 * Must not run GUI / TCC probes unattended: a LaunchAgent or headless
 * npm cannot click Allow. The operator runs `apple-tools-mcp permissions`
 * on the host UI.
 */

export function postinstallReminderText() {
  return [
    "apple-tools-mcp: after first install or upgrade, run permissions on the Mac UI",
    "(with System Settings → Privacy & Security → Automation open):",
    "",
    "  apple-tools-mcp permissions",
    "  npx apple-tools-mcp permissions",
    "",
    "Use the same node binary the product uses (process.execPath).",
    "This reminder does not grant anything and does not run the probes."
  ].join("\n");
}

export function printPostinstallReminder(write = console.log) {
  write(postinstallReminderText());
}

if (process.argv[1] && /postinstall\.js$/.test(process.argv[1])) {
  printPostinstallReminder();
}
