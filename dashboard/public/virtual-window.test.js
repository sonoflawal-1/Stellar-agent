import test from "node:test";
import assert from "node:assert/strict";
import "./virtual-window.js";

const computeVirtualWindow = globalThis.computeVirtualWindow;

test("renders everything when the list fits in the viewport", () => {
  const range = computeVirtualWindow(5, 0, 500, 80, 2);
  assert.equal(range.start, 0);
  assert.equal(range.end, 5);
  assert.equal(range.offsetY, 0);
  assert.equal(range.totalHeight, 400);
});

test("windows a long list around the scroll offset with overscan", () => {
  const range = computeVirtualWindow(1000, 4000, 480, 80, 3);
  assert.equal(range.start, 47);
  assert.equal(range.end, 59);
  assert.equal(range.offsetY, 47 * 80);
  assert.equal(range.totalHeight, 1000 * 80);
});

test("clamps the window at the end of the list", () => {
  const range = computeVirtualWindow(10, 10000, 480, 80, 4);
  assert.equal(range.start, 0);
  assert.equal(range.end, 10);
  assert.equal(range.offsetY, 0);
});

test("never returns a negative start", () => {
  const range = computeVirtualWindow(100, -50, 200, 80, 5);
  assert.equal(range.start, 0);
  assert.equal(range.end, 13);
});

test("handles empty and invalid inputs", () => {
  assert.deepEqual(computeVirtualWindow(0, 0, 500, 80, 2), {
    start: 0,
    end: 0,
    offsetY: 0,
    totalHeight: 0,
  });
  assert.deepEqual(computeVirtualWindow(10, 0, 500, 0, 2), {
    start: 0,
    end: 0,
    offsetY: 0,
    totalHeight: 0,
  });
});
