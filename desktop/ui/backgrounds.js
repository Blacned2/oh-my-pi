// Chat background: the nebula gradient (default) or one of the images in ./backgrounds.
// Shared by the first-paint script (index.html) and the settings page. The choice lives in localStorage.
// To add an image: drop it in ui/backgrounds and add a row to IMAGES.
(() => {
  const KEY = "kostomp-chat-background";
  const IMAGES = [
    { id: "astronomy", name: "Astronomy", file: "pexels-astronomy-1867616.jpg" },
    { id: "arch", name: "Arch", file: "whitechappel79-arch-5678549.jpg" },
    { id: "ocean", name: "Ocean", file: "jplenio-ocean-3605547.jpg" },
    { id: "ai-art", name: "AI art", file: "quirkjunkjournals-ai-generated-8180966_1920.png" },
    { id: "crystal-cave", name: "Crystal cave", file: "anime-crystal-cave-magical-glowing-underground-kromawalls.jpg" },
    { id: "mushroom-forest", name: "Mushroom forest", file: "anime-dark-forest-glowing-mushrooms-magical-night-kromawalls.jpg" },
    { id: "sky-kingdom", name: "Sky kingdom", file: "anime-fantasy-kingdom-mountain-aerial-magical-clouds-kromawalls.jpg" },
    { id: "neon-city", name: "Neon city", file: "anime-cityscape-futuristic-neon-night-rain-reflections-kromawalls.jpg" },
    { id: "black-light", name: "Black light", file: "black-light-01.png" },
    { id: "painterly-coast", name: "Painterly coast", file: "painterly-coast-main.png" },
  ].map((b) => ({ ...b, url: "backgrounds/" + b.file }));

  const NEBULA = "nebula";
  const byId = (id) => IMAGES.find((b) => b.id === id);
  const current = () => {
    const id = localStorage.getItem(KEY);
    return byId(id) ? id : NEBULA;
  };

  // Sets (or clears) --chat-bg on <html>; the chat pane falls back to the nebula when it is unset.
  function apply(id) {
    const root = document.documentElement.style;
    const img = byId(id);
    if (img) root.setProperty("--chat-bg", `url("${img.url}") center / cover no-repeat`);
    else root.removeProperty("--chat-bg");
  }

  function set(id) {
    if (byId(id)) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY);
    apply(id);
  }

  apply(current());
  window.kostompBackgrounds = { IMAGES, NEBULA, current, set };
})();
