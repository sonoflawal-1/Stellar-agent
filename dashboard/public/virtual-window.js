// Pure windowing maths for the dashboard's virtualized history feed (#762).
// Kept dependency-free so it can run in the browser (classic script) and be
// unit-tested directly by Node.
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.computeVirtualWindow = api.computeVirtualWindow;
    root.virtualWindow = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function computeVirtualWindow(total, scrollTop, viewportHeight, rowHeight, overscan) {
    var count = Math.max(0, Number(total) || 0);
    var height = Math.max(0, Number(rowHeight) || 0);
    if (count === 0 || height === 0) {
      return { start: 0, end: 0, offsetY: 0, totalHeight: 0 };
    }
    var view = Math.max(0, Number(viewportHeight) || 0);
    var pad = Math.max(0, Number(overscan) || 0);
    var visible = Math.max(1, Math.ceil(view / height) + pad * 2);
    var first = Math.max(0, Math.floor(Math.max(0, Number(scrollTop) || 0) / height) - pad);
    first = Math.min(first, Math.max(0, count - visible));
    var end = Math.min(count, first + visible);
    return {
      start: first,
      end: end,
      offsetY: first * height,
      totalHeight: count * height,
    };
  }

  return { computeVirtualWindow: computeVirtualWindow };
});
