// Window material painter shared by the first-paint script (index.html) and the settings page.
// The Rust side (window_style.rs) stores the numbers; this turns them into CSS variables.
(() => {
  // Glass types. Every preset is a full set of the tunable values, so picking one and then nudging a
  // slider is just "custom". blur: 0 none, 1 Mica, 2 Acrylic, 3 Mica Alt. Colours "" follow the theme.
  const TYPES = [
    { id: "frosted", name: "Thin frosted", desc: "Light tint, fine grain. The default.",
      v: { blur: 2, tint: 38, tintColor: "", sheen: 7, rim: 14, grain: 10, paneBlur: 20, saturation: 150, glow: 28 } },
    { id: "clear", name: "Clear", desc: "Almost see-through, no system blur.",
      v: { blur: 0, tint: 16, tintColor: "", sheen: 10, rim: 24, grain: 0, paneBlur: 10, saturation: 120, glow: 20 } },
    { id: "mica", name: "Mica", desc: "Soft wallpaper-tinted material.",
      v: { blur: 1, tint: 46, tintColor: "", sheen: 4, rim: 10, grain: 6, paneBlur: 16, saturation: 110, glow: 18 } },
    { id: "soft", name: "Soft", desc: "Mica Alt: deeper, calmer tint.",
      v: { blur: 3, tint: 42, tintColor: "", sheen: 5, rim: 12, grain: 8, paneBlur: 18, saturation: 115, glow: 22 } },
    { id: "smoked", name: "Smoked", desc: "Dark tinted glass, best for reading.",
      v: { blur: 2, tint: 72, tintColor: "#0a0a10", sheen: 3, rim: 8, grain: 12, paneBlur: 24, saturation: 100, glow: 10 } },
    { id: "ice", name: "Ice", desc: "Cool, bright, strong edge light.",
      v: { blur: 2, tint: 24, tintColor: "#cfe6ff", sheen: 18, rim: 32, grain: 4, paneBlur: 22, saturation: 180, glow: 36 } },
    { id: "amethyst", name: "Amethyst", desc: "Violet-tinted, vivid through panes.",
      v: { blur: 2, tint: 44, tintColor: "#2a1668", sheen: 9, rim: 18, grain: 8, paneBlur: 22, saturation: 190, glow: 40 } },
    { id: "rose", name: "Rose quartz", desc: "Warm pink glass with a gentle glow.",
      v: { blur: 2, tint: 40, tintColor: "#5a1f3d", sheen: 10, rim: 20, grain: 8, paneBlur: 20, saturation: 170, glow: 38 } },
  ];

  const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");

  // Paints settings onto <html>. `glass` (when given) switches the material; the variables are always
  // set so the accent applies to the opaque window too.
  function paint(s, glass) {
    const root = document.documentElement;
    const st = root.style;
    if (glass !== undefined) root.dataset.material = glass ? "glass" : "opaque";
    st.setProperty("--glass-a", String(s.tint / 100));
    if (s.tintColor) st.setProperty("--glass-rgb", rgbOf(s.tintColor)); else st.removeProperty("--glass-rgb");
    st.setProperty("--glass-sheen-a", String(s.sheen / 100));
    st.setProperty("--glass-rim-a", String(s.rim / 100));
    st.setProperty("--glass-grain-a", String(s.grain / 200));
    st.setProperty("--glass-pane-blur", s.paneBlur + "px");
    st.setProperty("--glass-sat", String(s.saturation / 100));
    st.setProperty("--glow-a", String(s.glow / 100));
    for (const v of ["--accent", "--focus"]) {
      if (s.accent) st.setProperty(v, s.accent); else st.removeProperty(v);
    }
  }

  window.kostompMaterial = { TYPES, paint, rgbOf };
})();
