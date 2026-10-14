use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub kind: String,
    pub start: f64,
    pub end: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub text: String,
    pub color: String,
    pub background: String,
    #[serde(default = "one")]
    pub background_opacity: f64,
    pub opacity: f64,
    pub line_width: f64,
    pub font_size: f64,
    pub font_family: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct OverlayAsset {
    pub id: String,
    pub png: String,
}
fn one() -> f64 {
    1.0
}
pub fn validate(a: &Annotation, total: f64) -> Result<(), String> {
    let kinds = [
        "text",
        "arrow",
        "rectangle",
        "ellipse",
        "marker",
        "highlight",
        "blur",
        "mosaic",
    ];
    let color = |s: &str| {
        s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
    };
    if !kinds.contains(&a.kind.as_str())
        || ![
            a.start,
            a.end,
            a.x,
            a.y,
            a.width,
            a.height,
            a.opacity,
            a.background_opacity,
            a.line_width,
            a.font_size,
        ]
        .iter()
        .all(|v| v.is_finite())
        || a.start < 0.0
        || a.end <= a.start
        || a.end > total + 0.05
        || a.x < 0.0
        || a.y < 0.0
        || a.width <= 0.0
        || a.height <= 0.0
        || a.x + a.width > 1.001
        || a.y + a.height > 1.001
        || !(0.0..=1.0).contains(&a.opacity)
        || !(0.0..=1.0).contains(&a.background_opacity)
        || !(0.0..=20.0).contains(&a.line_width)
        || !(8.0..=160.0).contains(&a.font_size)
        || !color(&a.color)
        || !color(&a.background)
        || a.text.len() > 4000
        || a.font_family.len() > 400
    {
        return Err("注釈の表示範囲・色・文字情報が不正です".into());
    }
    Ok(())
}
pub fn write_asset(
    asset: &OverlayAsset,
    path: &std::path::Path,
    w: u32,
    h: u32,
) -> Result<(), String> {
    use base64::Engine;
    if asset.png.len() > 45_000_000 {
        return Err("注釈画像が大きすぎます".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&asset.png)
        .map_err(|_| "注釈画像が不正です")?;
    let decoder = png::Decoder::new(std::io::Cursor::new(&bytes));
    let mut reader = decoder.read_info().map_err(|_| "注釈PNGを読み込めません")?;
    if reader.info().width != w
        || reader.info().height != h
        || reader.output_buffer_size() > 128_000_000
    {
        return Err("注釈画像の解像度が出力と一致しません".into());
    }
    let mut pixels = vec![0; reader.output_buffer_size()];
    reader
        .next_frame(&mut pixels)
        .map_err(|_| "注釈PNGのデコードに失敗しました")?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}
