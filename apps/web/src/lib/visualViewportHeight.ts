/**
 * Publishes the visual viewport height as `--app-viewport-height`.
 *
 * `svh` is a static number: the height the viewport *would* have with the
 * browser's toolbars expanded. It does not track the toolbars actually
 * collapsing or expanding, and it does not react to the on-screen keyboard. On
 * iOS Safari that leaves the bottom of a `h-svh` shell sitting under the
 * browser's own bottom bar, which clips whatever is docked there: for us, the
 * composer's controls.
 *
 * The visual viewport is the part the user can really see, so tracking it keeps
 * the shell inside the visible area in both cases. Consumers should fall back to
 * `100svh` for the first paint and for browsers without the API.
 */
const CSS_VARIABLE = "--app-viewport-height";

export function syncVisualViewportHeight(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }

  const viewport = window.visualViewport;
  if (!viewport) {
    return () => undefined;
  }

  const apply = () => {
    document.documentElement.style.setProperty(CSS_VARIABLE, `${viewport.height}px`);
  };

  apply();
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);

  return () => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
    document.documentElement.style.removeProperty(CSS_VARIABLE);
  };
}
