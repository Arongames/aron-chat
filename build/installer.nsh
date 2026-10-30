; ============================================================
; Оформление установщика Aron Chat.
; NSIS/MUI2 позволяет красить только страницы Welcome/Finish
; (и поля ввода на странице каталога). Остальные элементы —
; системные, их цвет задаёт Windows.
; ============================================================

; Тёмная палитра приложения
!define MUI_BGCOLOR "0B0D11"
!define MUI_TEXTCOLOR "E9E9EC"

; Цвета поля пути и подписи на странице каталога
!define MUI_DIRECTORYPAGE_BGCOLOR "0B0D11"
!define MUI_DIRECTORYPAGE_TEXTCOLOR "E9E9EC"

; Фирменная страница приветствия
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Aron Chat"
  !define MUI_WELCOMEPAGE_TEXT "Чат TikTok, Twitch и YouTube в одном окне, офлайн-озвучка и два оверлея для OBS.$\r$\n$\r$\nНажмите «Далее», чтобы установить приложение."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Страница завершения: тёмный фон уже берётся из MUI_BGCOLOR,
; дополнительно включаем запуск приложения после установки.
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend
