// Library entry point for Android and other platforms

mod commands;
mod external_links;
mod memory_db;
mod microphone_permission;
mod realtime_transport;
mod screenshot;
mod storage;

use commands::{AttachmentStreamState, HttpAbortState, HttpStreamState, WallpaperStreamState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(microphone_permission::init());
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    builder
        .invoke_handler(tauri::generate_handler![
            external_links::open_external_url,
            commands::exit_app,
            commands::restart_app,
            commands::save_config,
            commands::load_config,
            commands::save_chat_history,
            commands::get_chat_history,
            commands::clear_chat_history,
            commands::save_world_info,
            commands::get_world_info,
            commands::delete_world_info,
            commands::world_info_exists,
            commands::list_world_info_files,
            commands::save_character,
            commands::get_characters,
            commands::save_persona_card,
            commands::load_persona_card,
            commands::delete_persona_card,
            commands::save_kv,
            commands::load_kv,
            commands::delete_worldinfo_legacy_store,
            commands::list_contacts_by_scopes,
            commands::cleanup_persona_scoped_data,
            commands::chat_store_v2_read_index,
            commands::chat_store_v2_write_index,
            commands::chat_store_v2_read_part,
            commands::chat_store_v2_write_part,
            commands::chat_store_v2_delete_part,
            commands::chat_store_v2_write_field,
            commands::chat_store_v2_read_field,
            commands::chat_store_v2_delete_field,
            commands::chat_store_v2_delete_thread,
            commands::chat_store_v2_delete_session,
            commands::ensure_media_bundle,
            commands::save_wallpaper,
            commands::save_wallpaper_chunked,
            commands::save_wallpaper_stream_start,
            commands::save_wallpaper_stream_chunk,
            commands::save_wallpaper_stream_finish,
            commands::delete_wallpaper,
            commands::wallpaper_path_exists,
            commands::cleanup_wallpapers,
            commands::save_attachment,
            commands::save_attachment_bytes,
            commands::read_attachment_data_url,
            commands::save_attachment_stream_start,
            commands::save_attachment_stream_chunk,
            commands::save_attachment_stream_finish,
            commands::delete_attachment,
            commands::export_attachment,
            commands::pick_save_path,
            commands::write_text_file,
            commands::export_sticker_gif,
            commands::export_sticker_zip,
            commands::export_data_bundle,
            commands::import_data_bundle,
            commands::import_data_bundle_bytes,
            commands::http_request,
            commands::public_http_request,
            commands::http_stream_request_start,
            commands::http_stream_request_read,
            commands::http_stream_request_close,
            commands::http_abort_request,
            commands::openai_realtime_create_call,
            realtime_transport::realtime_transport_open,
            realtime_transport::realtime_transport_send,
            realtime_transport::realtime_transport_close,
            microphone_permission::prepare_microphone_permission_retry,
            microphone_permission::open_microphone_permission_settings,
            commands::log_js,
            commands::save_raw_reply,
            commands::load_raw_reply,
            commands::delete_raw_reply,
            commands::read_plugin_zip,
            commands::read_zip_entries,
            commands::init_database,
            commands::create_memory,
            commands::update_memory,
            commands::delete_memory,
            commands::get_memories,
            commands::batch_create_memories,
            commands::batch_delete_memories,
            commands::save_template,
            commands::get_templates,
            commands::delete_template,
            screenshot::capture_viewport_region,
        ])
        .setup(|_app| {
            let handle = _app.handle();
            let memory_db = memory_db::MemoryDb::new(&handle)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            _app.manage(memory_db);
            _app.manage(WallpaperStreamState::default());
            _app.manage(AttachmentStreamState::default());
            _app.manage(HttpAbortState::default());
            _app.manage(HttpStreamState::default());
            _app.manage(realtime_transport::RealtimeTransportState::default());
            #[cfg(all(debug_assertions, not(any(target_os = "android", target_os = "ios"))))]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
