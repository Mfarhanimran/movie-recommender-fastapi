const $ = (s, el = document) => el.querySelector(s);

// Poster colour comes from each movie's first genre.
const COLORS = {
  Action: "#C2410C", Adventure: "#0F766E", Animation: "#7C3AED", Comedy: "#B45309",
  Crime: "#1E293B", Documentary: "#3F6212", Drama: "#9F1239", Family: "#0369A1",
  Fantasy: "#86198F", Foreign: "#6B7280", History: "#78350F", Horror: "#4A0D0D",
  Music: "#BE185D", Mystery: "#3730A3", Romance: "#C026D3", "Science Fiction": "#1D4ED8",
  "TV Movie": "#475569", Thriller: "#115E59", War: "#57534E", Western: "#A16207",
  none: "#52525B",
};

const state = { mode: "title", seedId: null, trail: [], items: [], active: -1, typing: 0 };

/* ---------- api ---------- */
async function api(path, params = {}) {
  const url = new URL("/api" + path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== "" && v != null) url.searchParams.set(k, v);
  let res;
  try { res = await fetch(url); }
  catch { throw new Error("Can’t reach the recommender. Check that the server is running."); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `Request failed (${res.status})`);
  }
  return res.json();
}
const filters = () => ({
  n: $("#count").value,
  min_rating: $("#rating").value,
  genre: $("#genre").value,
});
const say = (t) => { $("#status").textContent = t; };

/* ---------- building blocks ---------- */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function poster(m) {
  const p = el("div", "poster");
  p.style.setProperty("--c", COLORS[m.genres[0]] || COLORS.none);
  p.dataset.len = m.title.length <= 14 ? "s" : m.title.length <= 28 ? "m" : "l";
  const initial = (m.title.match(/[\p{L}\p{N}]/u) || [m.title[0] || "?"])[0].toUpperCase();
  p.append(el("span", "initial", initial), el("span", "ptitle", m.title));
  p.firstChild.setAttribute("aria-hidden", "true");
  if (m.rating > 0) p.append(el("span", "pr", "★ " + m.rating.toFixed(1)));
  return p;
}

function card(m, maxScore, onPick) {
  const b = el("button", "card");
  b.type = "button";
  b.append(poster(m));
  const meta = el("div", "meta");
  if (m.score != null) {
    const bar = el("div", "bar");
    const fill = document.createElement("i");
    fill.style.width = Math.max(4, (m.score / maxScore) * 100) + "%";
    bar.append(fill);
    meta.append(bar, el("p", "sim", Math.round(m.score * 100) + "% similar"));
  }
  meta.append(el("p", "genres", m.genres.join(", ") || "No genre listed"));
  if (m.overview) meta.append(el("p", "ov-s", m.overview));
  b.append(meta);
  b.addEventListener("click", () => onPick(m));
  return b;
}

function notice(title, body) {
  const d = el("div", "notice");
  d.append(el("strong", null, title), el("span", null, body));
  return d;
}

function showSkeleton() {
  const g = $("#grid");
  g.replaceChildren(...Array.from({ length: Math.min(+$("#count").value, 12) }, () => el("div", "skel")));
}

/* ---------- by movie ---------- */
async function loadMovie(id, { reset = false, trailIndex = null } = {}) {
  setMode("title");
  $("#results").hidden = false;
  $("#layout").classList.remove("no-seed");
  showSkeleton();
  try {
    const data = await api(`/recommend/${id}`, filters());
    const seed = data.seed;
    if (reset) state.trail = [];
    else if (trailIndex != null) state.trail = state.trail.slice(0, trailIndex);
    state.trail.push({ id: seed.id, title: seed.title });
    state.seedId = seed.id;
    history.replaceState(null, "", `#movie=${seed.id}`);

    renderTrail();
    renderSeed(seed);
    $("#rtitle").textContent = `Because you liked ${seed.title}`;
    $("#rmeta").textContent = "Pick any movie below to explore from there.";
    renderGrid(data.results, (m) => loadMovie(m.id));
    say(`${data.results.length} recommendations for ${seed.title}`);
    if (reset) $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    $("#grid").replaceChildren(notice("Couldn’t load recommendations", err.message));
  }
}

function renderSeed(m) {
  const s = $("#seed");
  s.hidden = false;
  const facts = [m.rating > 0 ? `★ ${m.rating.toFixed(1)}` : "Not yet rated", m.genres.join(", ")]
    .filter(Boolean).join("  |  ");
  s.replaceChildren(poster(m), el("h3", null, m.title));
  if (m.tagline) s.append(el("p", "tag", m.tagline));
  s.append(el("p", "facts", facts), el("p", "ov", m.overview || "No overview available."));
}

function renderTrail() {
  const t = $("#trail");
  t.replaceChildren(el("span", null, "Your path:"));
  state.trail.forEach((step, i) => {
    t.append(el("span", "sep"));
    if (i === state.trail.length - 1) {
      const cur = el("span", null, step.title);
      cur.setAttribute("aria-current", "true");
      t.append(cur);
    } else {
      const b = el("button", null, step.title);
      b.type = "button";
      b.addEventListener("click", () => loadMovie(step.id, { trailIndex: i }));
      t.append(b);
    }
  });
  t.hidden = state.trail.length < 2;
}

function renderGrid(results, onPick) {
  const g = $("#grid");
  if (!results.length) {
    g.replaceChildren(notice("No matches with these filters",
      "Lower the minimum rating, choose Any genre, or try a different movie."));
    return;
  }
  const max = Math.max(...results.map((r) => r.score || 0)) || 1;
  g.replaceChildren(...results.map((m) => card(m, max, onPick)));
}

/* ---------- by description ---------- */
async function loadDescription(q) {
  setMode("text");
  $("#results").hidden = false;
  $("#layout").classList.add("no-seed");
  $("#seed").hidden = true;
  $("#trail").hidden = true;
  history.replaceState(null, "", location.pathname);
  showSkeleton();
  try {
    const data = await api("/describe", { q, ...filters() });
    $("#rtitle").textContent = `Movies matching “${q}”`;
    $("#rmeta").textContent = data.matched_terms.length
      ? `We matched on: ${data.matched_terms.join(", ")}`
      : "";
    if (!data.matched_terms.length) {
      $("#grid").replaceChildren(notice("We didn’t recognise any words in that",
        "Try describing the plot, setting or characters, for example “a detective hunts a serial killer in a snowy town”."));
      return;
    }
    renderGrid(data.results, (m) => loadMovie(m.id, { reset: true }));
    say(`${data.results.length} movies match your description`);
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    $("#grid").replaceChildren(notice("Couldn’t search", err.message));
  }
}

/* ---------- autocomplete ---------- */
const list = $("#suggest"), input = $("#q");

function closeSuggest() {
  list.hidden = true; input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant"); state.active = -1;
}
function paintActive() {
  [...list.children].forEach((li, i) => li.setAttribute("aria-selected", i === state.active));
  if (state.active >= 0) input.setAttribute("aria-activedescendant", `opt-${state.active}`);
}
function renderSuggest() {
  if (!state.items.length) return closeSuggest();
  list.replaceChildren(...state.items.map((m, i) => {
    const li = el("li");
    li.id = `opt-${i}`; li.setAttribute("role", "option"); li.setAttribute("aria-selected", "false");
    li.append(el("span", null, m.title), el("small", null, m.genres.slice(0, 3).join(", ")));
    li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(m); });
    return li;
  }));
  list.hidden = false; input.setAttribute("aria-expanded", "true"); state.active = -1;
}
function choose(m) {
  input.value = m.title;
  closeSuggest();
  loadMovie(m.id, { reset: true });
}
let timer;
input.addEventListener("input", () => {
  clearTimeout(timer);
  const q = input.value.trim();
  if (!q) { state.items = []; return closeSuggest(); }
  const ticket = ++state.typing;
  timer = setTimeout(async () => {
    try {
      const items = await api("/search", { q });
      if (ticket !== state.typing) return; // a newer keystroke won
      state.items = items; renderSuggest();
    } catch { closeSuggest(); }
  }, 140);
});
input.addEventListener("keydown", (e) => {
  if (list.hidden) return;
  if (e.key === "ArrowDown") { e.preventDefault(); state.active = (state.active + 1) % state.items.length; paintActive(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); state.active = (state.active - 1 + state.items.length) % state.items.length; paintActive(); }
  else if (e.key === "Escape") closeSuggest();
});
input.addEventListener("blur", closeSuggest);

/* ---------- form, mode, filters ---------- */
$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.mode === "text") {
    const q = $("#desc").value.trim();
    if (q.length < 3) return say("Type at least a few words to describe the movie.");
    return loadDescription(q);
  }
  if (state.active >= 0 && !list.hidden) return choose(state.items[state.active]);
  const q = input.value.trim();
  if (!q) return;
  try {
    const items = await api("/search", { q, limit: 1 });
    if (items.length) choose(items[0]);
    else { $("#results").hidden = false; $("#seed").hidden = true; $("#trail").hidden = true;
      $("#rtitle").textContent = ""; $("#rmeta").textContent = "";
      $("#grid").replaceChildren(notice(`No movie called “${q}”`, "Check the spelling, or switch to By description.")); }
  } catch (err) { say(err.message); }
});

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll(".modes button")) b.setAttribute("aria-selected", b.dataset.mode === mode);
  $("#field-title").hidden = mode !== "title";
  $("#field-text").hidden = mode !== "text";
}
document.querySelectorAll(".modes button").forEach((b) =>
  b.addEventListener("click", () => { setMode(b.dataset.mode); (state.mode === "title" ? input : $("#desc")).focus(); }));

function refresh() {
  if (state.mode === "title" && state.seedId != null) {
    const keep = state.trail.length - 1;
    loadMovie(state.seedId, { trailIndex: keep });
  } else if (state.mode === "text" && $("#desc").value.trim().length >= 3 && !$("#results").hidden) {
    loadDescription($("#desc").value.trim());
  }
}
const ratingOut = () => { $("#rating-out").textContent = +$("#rating").value === 0 ? "Any" : $("#rating").value + "+"; };
let rt;
$("#rating").addEventListener("input", () => { ratingOut(); clearTimeout(rt); rt = setTimeout(refresh, 250); });
$("#genre").addEventListener("change", refresh);
$("#count").addEventListener("change", refresh);

/* ---------- startup ---------- */
async function init() {
  ratingOut();
  try {
    const [genres, popular] = await Promise.all([api("/genres"), api("/popular", { limit: 12 })]);
    $("#genre").append(...genres.map((g) => { const o = el("option", null, g); o.value = g; return o; }));
    $("#popular").replaceChildren(...popular.map((m) => card(m, 1, (x) => loadMovie(x.id, { reset: true }))));
    // Rail cards show only the poster and genres
    document.querySelectorAll("#popular .ov-s").forEach((n) => n.remove());
  } catch (err) {
    $("#popular").replaceChildren(notice("Can’t reach the recommender", err.message));
  }
  const m = location.hash.match(/movie=(\d+)/);
  if (m) loadMovie(+m[1], { reset: true });
}
init();
