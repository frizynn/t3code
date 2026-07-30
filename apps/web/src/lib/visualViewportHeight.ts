/**
 * Publishes the visual viewport's geometry as `--app-viewport-height` and
 * `--app-viewport-offset-top`.
 *
 * `svh` is a static number: the height the viewport *would* have with the
 * browser's toolbars expanded. It does not track the toolbars actually
 * collapsing or expanding, and it does not react to the on-screen keyboard. On
 * iOS Safari that leaves the bottom of a `h-svh` shell sitting under the
 * browser's own bottom bar, which clips whatever is docked there: for us, the
 * composer's controls.
 *
 * The offset matters just as much. When the keyboard opens and the browser does
 * not honour `interactive-widget=resizes-content`, the layout viewport keeps its
 * full height and iOS pans the visual viewport down over it to reveal the
 * focused field. Nothing in CSS reacts to that pan, so a shell anchored to the
 * layout viewport slides off the top of the screen and the whole page reads as
 * being dragged around. `offsetTop` is how far it panned; pinning the shell to
 * it keeps the app still under the keyboard.
 *
 * Consumers should fall back to `100svh` and `0px` for the first paint and for
 * browsers without the API.
 */
const HEIGHT_VARIABLE = "--app-viewport-height";
const OFFSET_TOP_VARIABLE = "--app-viewport-offset-top";

export function syncVisualViewportHeight(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }

  const viewport = window.visualViewport;
  if (!viewport) {
    return () => undefined;
  }

  let frame: number | null = null;
  let lastHeight: string | null = null;
  let lastOffsetTop: string | null = null;

  // Writing a custom property on the root element invalidates style for the
  // whole tree, so skip the write when the geometry is unchanged. iOS keeps
  // firing `scroll` after a pan has settled, and every one of those events
  // would otherwise cost a full recalc.
  const write = () => {
    frame = null;
    const { style } = document.documentElement;
    const height = `${viewport.height}px`;
    const offsetTop = `${viewport.offsetTop}px`;
    if (height !== lastHeight) {
      lastHeight = height;
      style.setProperty(HEIGHT_VARIABLE, height);
    }
    if (offsetTop !== lastOffsetTop) {
      lastOffsetTop = offsetTop;
      style.setProperty(OFFSET_TOP_VARIABLE, offsetTop);
    }
  };

  // iOS fires `scroll` for every frame of the keyboard's pan animation, and
  // writing a custom property from each one forces a layout mid-animation. One
  // write per frame keeps the shell steady instead of stuttering behind the pan.
  const apply = () => {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(write);
  };

  write();
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);

  return () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    lastHeight = null;
    lastOffsetTop = null;
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
    document.documentElement.style.removeProperty(HEIGHT_VARIABLE);
    document.documentElement.style.removeProperty(OFFSET_TOP_VARIABLE);
  };
}
