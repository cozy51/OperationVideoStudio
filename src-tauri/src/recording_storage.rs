use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
pub fn load_folder(settings: &Path) -> Result<Option<PathBuf>, String> {
    if !settings.exists() {
        return Ok(None);
    }
    let folder: PathBuf = serde_json::from_slice(&fs::read(settings).map_err(|e| e.to_string())?)
        .map_err(|_| "録画保存先の設定を読み込めません")?;
    Ok(folder.is_dir().then_some(folder))
}
pub fn save_folder(settings: &Path, folder: &Path) -> Result<PathBuf, String> {
    let folder =
        fs::canonicalize(folder).map_err(|e| format!("保存先フォルダーを開けません: {e}"))?;
    if !folder.is_dir() {
        return Err("保存先はフォルダーを選択してください".into());
    }
    let parent = settings.parent().ok_or("設定の保存先が不正です")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    tmp.write_all(&serde_json::to_vec(&folder).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(settings).map_err(|e| e.to_string())?;
    Ok(folder)
}
pub fn reserve_recording(folder: &Path) -> Result<PathBuf, String> {
    let mut next = 1u64;
    for entry in fs::read_dir(folder).map_err(|e| format!("保存先を読み込めません: {e}"))?
    {
        let name = entry
            .map_err(|e| e.to_string())?
            .file_name()
            .to_string_lossy()
            .into_owned();
        if let Some(number) = name
            .strip_prefix("Rec_")
            .and_then(|s| s.strip_suffix(".mp4").or(Some(s)))
            .and_then(|s| s.parse::<u64>().ok())
        {
            next = next.max(number.checked_add(1).ok_or("録画の連番が上限です")?);
        }
    }
    loop {
        let path = folder.join(format!("Rec_{next:02}"));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                next = next.checked_add(1).ok_or("録画の連番が上限です")?;
            }
            Err(e) => return Err(format!("録画フォルダーを作成できません: {e}")),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_are_sequential_and_preserve_existing_files() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            reserve_recording(tmp.path()).unwrap().file_name().unwrap(),
            "Rec_01"
        );
        assert_eq!(
            reserve_recording(tmp.path()).unwrap().file_name().unwrap(),
            "Rec_02"
        );
        fs::write(tmp.path().join("Rec_09.mp4"), b"original").unwrap();
        assert_eq!(
            reserve_recording(tmp.path()).unwrap().file_name().unwrap(),
            "Rec_10"
        );
        assert_eq!(
            fs::read(tmp.path().join("Rec_09.mp4")).unwrap(),
            b"original"
        );
    }
    #[test]
    fn remembers_folder_after_restart_and_handles_missing_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let folder = tmp.path().join("日本語 保存先");
        fs::create_dir(&folder).unwrap();
        let settings = tmp.path().join("settings/folder.json");
        assert_eq!(load_folder(&settings).unwrap(), None);
        let saved = save_folder(&settings, &folder).unwrap();
        assert_eq!(load_folder(&settings).unwrap(), Some(saved));
        fs::remove_dir(folder).unwrap();
        assert_eq!(load_folder(&settings).unwrap(), None);
    }
}
