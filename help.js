// help.js -- the small "?" buttons next to each group of actions.
// Any element with data-help="key" gets a "?" button. Pressing it shows a
// short explanation of each action in that group (text: content.help[key]).
import { content } from "./content.js";

const help = content.help;
let openPop = null;

function close() {
  if (!openPop) return;
  openPop.pop.hidden = true;
  openPop.btn.setAttribute("aria-expanded", "false");
  openPop = null;
}

document.querySelectorAll("[data-help]").forEach((group, i) => {
  const items = help[group.dataset.help];
  if (!items) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "help-btn";
  btn.textContent = "?";
  btn.title = help.buttonLabel;
  btn.setAttribute("aria-label", help.buttonLabel);
  btn.setAttribute("aria-expanded", "false");

  const pop = document.createElement("div");
  pop.className = "help-pop";
  pop.id = "help-pop-" + i;
  pop.hidden = true;
  btn.setAttribute("aria-controls", pop.id);
  const list = document.createElement("dl");
  items.forEach((item) => {
    const dt = document.createElement("dt");
    dt.textContent = item.name;
    const dd = document.createElement("dd");
    dd.textContent = item.text;
    list.append(dt, dd);
  });
  pop.appendChild(list);

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = openPop && openPop.pop === pop;
    close();
    if (wasOpen) return;
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    openPop = { pop, btn };
  });

  group.appendChild(btn);
  group.after(pop);
});

document.addEventListener("click", (e) => {
  if (openPop && !openPop.pop.contains(e.target)) close();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") close();
});
