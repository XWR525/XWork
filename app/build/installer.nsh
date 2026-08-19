; electron-builder NSIS 自定义脚本（通过 nsis.include 挂载）
; 需求：用户在目录选择页通过「浏览」选择自定义文件夹后，自动在路径末尾追加应用文件夹名，
; 并同步更新页面上的路径编辑框，让用户在确认前就能看到最终安装目录（<所选目录>\XWork）。
; 原理：NSIS 在浏览对话框返回/目录变化时会调用 .onVerifyInstDir，
; 此时修改 $INSTDIR 并用 WM_SETTEXT 刷新目录页编辑框（控件 ID 1019）。

!macro customHeader
  Function .onVerifyInstDir
    ; 判断 $INSTDIR 末尾是否已含应用文件夹名，避免重复追加
    StrLen $2 "${APP_FILENAME}"
    StrCpy $1 $INSTDIR "" -$2
    ${If} $1 != "${APP_FILENAME}"
      ; 追加应用文件夹名（兼容末尾带反斜杠的路径）
      StrCpy $3 "$INSTDIR" "" -1
      ${If} $3 == "\"
        StrCpy $INSTDIR "$INSTDIR${APP_FILENAME}"
      ${Else}
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${EndIf}
      ; 同步更新目录页路径编辑框，立即显示追加后的路径
      FindWindow $0 "#32770" "" $HWNDPARENT
      GetDlgItem $0 $0 1019
      SendMessage $0 ${WM_SETTEXT} 0 "STR:$INSTDIR"
    ${EndIf}
  FunctionEnd
!macroend
