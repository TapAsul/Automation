function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isIOSChrome(): boolean {
  if (typeof navigator === "undefined") return false;
  return /CriOS/i.test(navigator.userAgent || "");
}

export async function downloadMediaFile(url: string, filename: string): Promise<void> {
  if (!url) return;

  // On mobile (iPhone Safari/Chrome & Android), prefer the native Share / Save Video sheet
  if (isMobileDevice()) {
    try {
      const res = await fetch(url);
      const rawBlob = await res.blob();
      const lower = filename.toLowerCase();
      const fallbackType = lower.endsWith(".mp4")
        ? "video/mp4"
        : lower.endsWith(".webm")
          ? "video/webm"
          : lower.endsWith(".wav")
            ? "audio/wav"
            : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
              ? "image/jpeg"
              : "image/png";
      const cleanType = (rawBlob.type || fallbackType).split(";")[0].trim() || fallbackType;
      const file = new File([rawBlob], filename, { type: cleanType });

      if (
        typeof navigator.share === "function" &&
        (!navigator.canShare || navigator.canShare({ files: [file] }))
      ) {
        await navigator.share({ files: [file], title: filename });
        return;
      }

      // Fallback for mobile browsers without file share (e.g. older iOS Chrome / WebViews):
      // upload temporarily to server and trigger a real attachment download header
      const tempProj = "proj_mobiledl0001";
      const kind = cleanType.startsWith("video/")
        ? "video"
        : cleanType.startsWith("audio/")
          ? "audio"
          : "concept";
      const baseId = filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 36) || "media";
      const params = new URLSearchParams({ label: filename, kind, mimeType: cleanType });
      const up = await fetch(`/api/projects/${tempProj}/assets/${baseId}?${params.toString()}`, {
        method: "PUT",
        headers: { "Content-Type": cleanType },
        body: rawBlob,
      });
      if (up.ok) {
        const ref = (await up.json()) as { url?: string };
        if (ref.url) {
          const dlUrl = `${ref.url}?download=1`;
          if (isIOSChrome()) {
            window.location.assign(dlUrl);
          } else {
            const a = document.createElement("a");
            a.href = dlUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          }
          return;
        }
      }

      // Android blob download fallback
      const objUrl = URL.createObjectURL(new Blob([rawBlob], { type: cleanType }));
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(objUrl), 60_000);
      return;
    } catch (err) {
      // If the user simply closed/cancelled the mobile share sheet, stop cleanly
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
    }
  }

  // Standard desktop / direct URL download
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}