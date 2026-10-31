; 卸载：询问是否保留 data，并按选择决定删不删安装目录。
;
; 为什么全塞进 customRemoveFiles：
;   electron-builder 的 customUnInstall 宏被插在 Section "un.install" 的**末尾**
;   （templates/nsis/uninstaller.nsh:238），而文件删除在同一个 Section 的开头
;   （:146 调用 customRemoveFiles），所以问在 customUnInstall 里已经晚了。
;
; 其它要点：
;   - 静默卸载（/S）与覆盖安装/升级一律保留数据，不弹框。
;   - 备份到 %TEMP% 再用 xcopy 拷回：直接 rename 到 $INSTDIR 的父目录在 C:\ 根下会因无权限静默失败。
;   - 2026-10-29 复查修复：恢复失败时不再删除备份（旧版恢复后无条件 RMDir 备份，恢复失败 = 丢数据）；
;     备份/恢复各用 xcopy 返回码 + .backup-ok 标记双重确认，任何一步失败都保留现场并打印路径。

!ifdef BUILD_UNINSTALLER
Var QQBOT_KEEP_DATA
Var QQBOT_BACKUP
!endif

!macro customRemoveFiles
  StrCpy $QQBOT_KEEP_DATA "1"
  ${ifNot} ${Silent}
    ${ifNot} ${isUpdated}
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "卸载时要不要一并删除数据？$\r$\n$\r$\n数据包括：聊天记录、记忆、表情包、API Key、主人号配置。$\r$\n$\r$\n是 = 全部删掉（彻底清空）$\r$\n否 = 只卸载程序，数据留在原目录，重装后接着用" \
        IDNO qqbotKeepData
      StrCpy $QQBOT_KEEP_DATA "0"
      qqbotKeepData:
    ${endIf}
  ${endIf}

  ${if} $QQBOT_KEEP_DATA == "1"
    StrCpy $QQBOT_BACKUP "$TEMP\qqbot-keep-data"
    ; 先清掉上一次残留的备份，免得把旧数据当成本次备份
    RMDir /r "$QQBOT_BACKUP"
    Delete "$TEMP\qqbot-keep-loc.txt"

    ; 1) 备份数据 → 备份成功才写 .backup-ok 标记
    nsExec::ExecToLog 'cmd /c if exist "$INSTDIR\data" xcopy /E /I /Q /Y "$INSTDIR\data" "$QQBOT_BACKUP"'
    Pop $0
    StrCmp $0 '0' 0 qqbotBackupFailed
    FileOpen $9 "$QQBOT_BACKUP\.backup-ok" w
    FileWrite $9 "ok"
    FileClose $9
    Goto qqbotBackupDone
    qqbotBackupFailed:
      DetailPrint "备份失败（xcopy 退出码 $0）：保留 $INSTDIR 不动"
      Goto qqbotUninstallDone
    qqbotBackupDone:

    nsExec::ExecToLog 'cmd /c if exist "$INSTDIR\data-location.txt" copy /Y "$INSTDIR\data-location.txt" "$TEMP\qqbot-keep-loc.txt"'
    Pop $0

    ; 标记不在 = 备份没真正落地，绝不能删安装目录
    IfFileExists "$QQBOT_BACKUP\.backup-ok" qqbotBackupOk
      DetailPrint "备份标记缺失：保留 $INSTDIR 不动"
      Goto qqbotUninstallDone
    qqbotBackupOk:

    ; 2) 删安装目录，再还原数据
    RMDir /r "$INSTDIR"
    CreateDirectory "$INSTDIR"

    nsExec::ExecToLog 'cmd /c if exist "$QQBOT_BACKUP" xcopy /E /I /Q /Y "$QQBOT_BACKUP" "$INSTDIR\data"'
    Pop $0
    StrCmp $0 '0' 0 qqbotRestoreFailed
    IfFileExists "$INSTDIR\data\.backup-ok" qqbotRestoreOk
    qqbotRestoreFailed:
      ; 恢复失败：备份必须留着，并告诉用户去哪儿找
      DetailPrint "恢复失败（xcopy 退出码 $0）：备份保留在 $QQBOT_BACKUP，请手动拷回 $INSTDIR\data"
      ${ifNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "数据恢复失败。$\r$\n$\r$\n备份还在：$QQBOT_BACKUP$\r$\n请手动拷回 $INSTDIR\data —— 不要删除这个备份目录。"
      ${endIf}
      Goto qqbotUninstallDone
    qqbotRestoreOk:
      Delete "$INSTDIR\data\.backup-ok"
      nsExec::ExecToLog 'cmd /c if exist "$TEMP\qqbot-keep-loc.txt" copy /Y "$TEMP\qqbot-keep-loc.txt" "$INSTDIR\data-location.txt"'
      Pop $0
      ; 只有到这里（恢复成功且验到标记）才允许删备份
      RMDir /r "$QQBOT_BACKUP"
      Delete "$TEMP\qqbot-keep-loc.txt"
      DetailPrint "已保留数据目录：$INSTDIR\data"

    Goto qqbotUninstallDone
  qqbotUninstallDone:
  ${else}
    RMDir /r "$INSTDIR"
    DetailPrint "已删除全部数据"
  ${endif}
!macroend

; close running app before upgrade (avoid file lock)
!macro customInit
  nsExec::Exec 'taskkill /F /IM DSChatBot.exe'
  nsExec::Exec 'taskkill /F /IM QQChatBot.exe'
  Sleep 900
!macroend
