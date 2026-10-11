/** Save a Blob or text as a file download. */
export function downloadBlob(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function downloadText(name: string, text: string, type = 'application/json'): void {
  downloadBlob(name, new Blob([text], { type }));
}
