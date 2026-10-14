use crate::media::{validate, Project};
use std::{fs, io::Write, path::Path};
pub fn save(dir: &Path, project: &Project) -> Result<(), String> {
    validate(project)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(project).map_err(|e| e.to_string())?;
    if bytes.len() > 10_000_000 {
        return Err("復旧データが上限の10MBを超えています".into());
    }
    let path = dir.join("recovery.json");
    if let Ok(old) = fs::read(&path) {
        if serde_json::from_slice::<Project>(&old)
            .ok()
            .and_then(|p| validate(&p).ok())
            .is_some()
        {
            atomic_write(dir, &dir.join("recovery.previous.json"), &old)?;
        }
    }
    atomic_write(dir, &path, &bytes)
}
fn atomic_write(dir: &Path, path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    tmp.write_all(bytes).map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn load(dir: &Path) -> Result<Option<Project>, String> {
    let mut exists = false;
    for name in ["recovery.json", "recovery.previous.json"] {
        let path = dir.join(name);
        if !path.exists() {
            continue;
        }
        exists = true;
        let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if size > 10_000_000 {
            continue;
        }
        if let Ok(bytes) = fs::read(path) {
            if let Ok(project) = serde_json::from_slice::<Project>(&bytes) {
                if validate(&project).is_ok() {
                    return Ok(Some(project));
                }
            }
        }
    }
    if exists {
        Err("復旧データを読み込めません。保存済みのプロジェクトを開いてください".into())
    } else {
        Ok(None)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restores_previous_snapshot_when_current_is_corrupt() {
        let tmp = tempfile::tempdir().unwrap();
        let p = Project {
            audio: vec![],
            version: 1,
            media: vec![],
            clips: vec![],
            annotations: vec![],
            clicks: vec![],
        };
        save(tmp.path(), &p).unwrap();
        let mut latest = p.clone();
        latest.version = 2;
        save(tmp.path(), &latest).unwrap();
        assert_eq!(load(tmp.path()).unwrap().unwrap().version, 2);
        fs::write(tmp.path().join("recovery.json"), b"broken").unwrap();
        assert_eq!(load(tmp.path()).unwrap().unwrap().version, 1);
    }
}
