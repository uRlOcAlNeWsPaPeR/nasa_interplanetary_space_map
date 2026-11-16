// guide.js -- the "How to use" guide: one place listing everything you can
// click, tap and press, grouped by task. Computers see mouse and keyboard
// controls, touch screens see gestures (text: content.guide). On a first
// visit the button pulses until it's opened once.
import { content } from "./content.js";

const g = content.guide;
const TOUCH = window.matchMedia("(pointer: coarse)").matches || /[?&]touch=1\b/.test(location.search);
const SEEN_KEY = "ridgeback-guide-seen";

const btn = document.getElementById("guide-open");
const dialog = document.getElementById("guide");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function render() {
  document.getElementById("guide-title").textContent = g.title;
  document.getElementById("guide-intro").textContent = TOUCH ? g.introTouch : g.intro;
  document.getElementById("guide-close").setAttribute("aria-label", g.close);
  const body = document.getElementById("guide-body");
  body.textContent = "";
  g.sections.forEach((section) => {
    const items = section.items
      .map((item) => ({ name: item.name, how: item.text || (TOUCH ? item.touch : item.mouse) }))
      .filter((item) => item.how);
    if (!items.length) return;
    const box = el("section", "guide-section");
    box.appendChild(el("h3", "", section.title));
    const list = el("dl");
    items.forEach((item) => list.append(el("dt", "", item.name), el("dd", "", item.how)));
    box.appendChild(list);
    body.appendChild(box);
  });
}

function seen() {
  try { return localStorage.getItem(SEEN_KEY) === "1"; } catch (e) { return true; }
}

function open() {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  btn.classList.remove("is-new");
  try { localStorage.setItem(SEEN_KEY, "1"); } catch (e) { /* private window: just don't remember */ }
}

function close() {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

if (btn && dialog && g) {
  btn.innerHTML = "";
  btn.append(el("span", "guide-q", "?"), el("span", "guide-label", g.button));
  btn.title = g.title;
  btn.setAttribute("aria-label", g.title);
  render();
  if (!seen()) btn.classList.add("is-new");
  btn.addEventListener("click", open);
  document.getElementById("guide-close").addEventListener("click", close);
  // A click on the dark area around the guide closes it.
  dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
}
