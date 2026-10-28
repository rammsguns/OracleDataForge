/** Copy text, including when the app is accessed over LAN HTTP. */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* Fall back to copying a selection. */ }

  const field = document.createElement("textarea");
  field.value = text;
  field.style.cssText = "position:fixed;left:-9999px;top:0";
  const focused = document.activeElement;
  document.body.appendChild(field);
  try {
    field.select();
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard access was blocked. Use the download option to save the JSON.");
    }
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus();
  }
}
