; OmniTavern 0.7.2 更名迁移：安装新版时静默卸载旧 "ChatApp"（AiChat 时代 productName）安装项。
; 用户数据位于 %APPDATA%\com.chatapp.dev，与安装目录无关；静默（/S）卸载不会出现
; “删除应用数据”勾选页，默认保留数据，因此该迁移不会触碰任何用户资料。
; 若未检测到旧安装项则完全跳过，对全新用户零影响。

!macro NSIS_HOOK_PREINSTALL
  ClearErrors
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatApp" "UninstallString"
  IfErrors legacy_chatapp_try_hklm
  ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatApp" "InstallLocation"
  Goto legacy_chatapp_found
legacy_chatapp_try_hklm:
  ClearErrors
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatApp" "UninstallString"
  IfErrors legacy_chatapp_done
  ReadRegStr $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatApp" "InstallLocation"
legacy_chatapp_found:
  StrCmp $R0 "" legacy_chatapp_done
  ; 旧版进程若在运行会导致文件占用，先结束（未运行时 taskkill 报错，忽略即可）
  ; nsExec 隐藏控制台窗口，避免安装时闪出 terminal 引起用户疑虑
  nsExec::Exec 'taskkill /F /IM tauri-chat-app.exe'
  Pop $R3
  ; 注册表值可能自带引号，去掉 InstallLocation 的外层引号
  StrCpy $R2 $R1 1
  StrCmp $R2 '"' 0 legacy_chatapp_unquoted
  StrCpy $R1 $R1 "" 1
  StrCpy $R1 $R1 -1
legacy_chatapp_unquoted:
  StrCmp $R1 "" legacy_chatapp_exec_simple
  ; _?= 让卸载器原地运行：ExecWait 才会真正等待完成；卸载器无法删除自身，事后清理残余
  ExecWait '$R0 /S _?=$R1' $R3
  Delete "$R1\uninstall.exe"
  RMDir "$R1"
  Goto legacy_chatapp_cleanup_reg
legacy_chatapp_exec_simple:
  ExecWait '$R0 /S' $R3
legacy_chatapp_cleanup_reg:
  ; 正常情况下旧卸载器会清理自己的注册表项；这里兜底删除，避免残留“ChatApp”卸载入口
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatApp"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChatApp"
  ; 快捷方式兜底清理（任务栏固定图标 Windows 不允许程序化移除，需用户右键取消固定）
  Delete "$DESKTOP\ChatApp.lnk"
  Delete "$SMPROGRAMS\ChatApp.lnk"
  RMDir /r "$SMPROGRAMS\ChatApp"
legacy_chatapp_done:
  ClearErrors
!macroend

; The protocol handler is registered when reply notifications are enabled.
; Remove only a handler owned by this installation; development uses a separate scheme.
!macro NSIS_HOOK_POSTUNINSTALL
  ReadRegStr $R0 HKCU "Software\Classes\omnitavern-reply\shell\open\command" ""
  StrCmp $R0 '$\"$INSTDIR\omnitavern.exe$\" $\"%1$\"' 0 reply_notification_cleanup_done
  DeleteRegKey HKCU "Software\Classes\omnitavern-reply"
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\com.chatapp.dev"
reply_notification_cleanup_done:
  ClearErrors
!macroend
