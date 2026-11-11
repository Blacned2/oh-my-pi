fn main() {
    // Keep the packaged WebView asset identical to the published dashboard stylesheet.
    let glass = "../packages/stats/src/client/glass.css";
    println!("cargo:rerun-if-changed={glass}");
    std::fs::copy(glass, "ui/glass.css").expect("copy shared Aurora material into desktop assets");
    tauri_build::build()
}
