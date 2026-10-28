; 3DViewer for Windows (WebView2): per-user install, no admin rights.
; makensis -DVERSION=2100.2.4 -DOUTFILE=3DViewer-Setup.exe -DEXE=path\3DViewer.exe installer.nsi
; Silent: /S ; /R (or --force-run, as Electron's updater passes) starts 3DViewer again afterwards.
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"

!define APPNAME "3DViewer"
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef OUTFILE
  !define OUTFILE "3DViewer-Setup.exe"
!endif
!ifndef EXE
  !define EXE "3DViewer.exe"
!endif
!define PROGID "3DViewer.Model"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "${UNKEY}" "InstallLocation"
BrandingText "${APPNAME} ${VERSION}"
VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} — CAD для самых маленьких"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "carnison"
VIAddVersionKey "LegalCopyright" "carnison"
VIAddVersionKey "FileVersion" "${VERSION}"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\3DViewer.exe"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

; 3D file types: listed in "Open with", and the default only for types nobody else opens (SolidWorks, Kompas... keep theirs)
!macro TDV_EXT EXT
  WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr HKCU "Software\Classes\Applications\3DViewer.exe\SupportedTypes" "${EXT}" ""
  ReadRegStr $0 HKCR "${EXT}" ""
  StrCmp $0 "" 0 +2
    WriteRegStr HKCU "Software\Classes\${EXT}" "" "${PROGID}"
!macroend
!macro TDV_UNEXT EXT
  DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}"
  ReadRegStr $0 HKCU "Software\Classes\${EXT}" ""
  StrCmp $0 "${PROGID}" 0 +2
    DeleteRegValue HKCU "Software\Classes\${EXT}" ""
!macroend
!macro TDV_ALL CMD
  !insertmacro ${CMD} ".step"
  !insertmacro ${CMD} ".stp"
  !insertmacro ${CMD} ".iges"
  !insertmacro ${CMD} ".igs"
  !insertmacro ${CMD} ".brep"
  !insertmacro ${CMD} ".stl"
  !insertmacro ${CMD} ".obj"
  !insertmacro ${CMD} ".3mf"
  !insertmacro ${CMD} ".glb"
  !insertmacro ${CMD} ".gltf"
  !insertmacro ${CMD} ".ply"
  !insertmacro ${CMD} ".fbx"
  !insertmacro ${CMD} ".3dv"
!macroend

Function CloseRunning
  ; a running 3DViewer holds its exe: ask it to close and wait a little (only the copy in this folder)
  nsExec::Exec `powershell -NoProfile -Command "Get-Process 3DViewer -EA 0 | ? { $$_.Path -like '$INSTDIR\*' } | % { $$_.CloseMainWindow() | Out-Null }"`
  Sleep 1500
  nsExec::Exec `powershell -NoProfile -Command "Get-Process 3DViewer -EA 0 | ? { $$_.Path -like '$INSTDIR\*' } | Stop-Process -Force"`
  Sleep 300
FunctionEnd

Function RemoveElectron
  ; the earlier Electron build lived in the same folder: its runtime files go
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\swiftshader"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vulkan-1.dll"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\Uninstall 3DViewer.exe"
  ; and its "Programs and Features" entry (electron-builder names it "3DViewer <version>")
  StrCpy $1 0
  loop:
    EnumRegKey $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $1
    StrCmp $2 "" done
    ReadRegStr $3 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$2" "DisplayName"
    ReadRegStr $4 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$2" "UninstallString"
    StrCpy $6 $3 8
    StrCmp $6 "${APPNAME}" 0 next
    StrCmp $2 "${APPNAME}" next
    ClearErrors
    ${WordFind} "$4" "Uninstall 3DViewer.exe" "E+1{" $5
    IfErrors next
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$2"
    Goto loop
    next:
    IntOp $1 $1 + 1
    Goto loop
  done:
FunctionEnd

Function .onInit
  ; an update over the earlier Electron build goes into the folder it was installed to
  ReadRegStr $0 HKCU "${UNKEY}" "InstallLocation"
  StrCmp $0 "" 0 found
  StrCpy $1 0
  scan:
    EnumRegKey $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $1
    StrCmp $2 "" found
    ReadRegStr $3 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$2" "DisplayName"
    ReadRegStr $4 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$2" "UninstallString"
    IntOp $1 $1 + 1
    StrCpy $6 $3 8
    StrCmp $6 "${APPNAME}" 0 scan
    ClearErrors
    ${WordFind} "$4" "\Uninstall 3DViewer.exe" "+1{" $5
    IfErrors scan
    StrCpy $5 $5 "" 1   ; drop the opening quote
    IfFileExists "$5\*.*" 0 scan
    StrCpy $INSTDIR $5
    Return
  found:
FunctionEnd

Section "3DViewer"
  Call CloseRunning
  SetOutPath "$INSTDIR"
  Call RemoveElectron
  File "/oname=3DViewer.exe" "${EXE}"
  FileOpen $0 "$INSTDIR\installed.flag" w
  FileWrite $0 "${VERSION}"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\3DViewer.exe"
  IfSilent +2
    CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\3DViewer.exe"

  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "${APPNAME} model"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\3DViewer.exe,0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\3DViewer.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\Applications\3DViewer.exe\shell\open\command" "" '"$INSTDIR\3DViewer.exe" "%1"'
  !insertmacro TDV_ALL TDV_EXT
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "carnison"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\3DViewer.exe"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" $0
SectionEnd

Function .onInstSuccess
  ; an update (/R from 3DViewer, --force-run from the old Electron updater) starts 3DViewer again
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/R" $1
  IfErrors 0 run
  ClearErrors
  ${GetOptions} $0 "--force-run" $1
  IfErrors 0 run
  Return
  run:
  Exec '"$INSTDIR\3DViewer.exe"'
FunctionEnd

Section "Uninstall"
  nsExec::Exec `powershell -NoProfile -Command "Get-Process 3DViewer -EA 0 | ? { $$_.Path -like '$INSTDIR\*' } | Stop-Process -Force"`
  !insertmacro TDV_ALL TDV_UNEXT
  DeleteRegKey HKCU "Software\Classes\${PROGID}"
  DeleteRegKey HKCU "Software\Classes\Applications\3DViewer.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$INSTDIR\3DViewer.exe"
  Delete "$INSTDIR\installed.flag"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNKEY}"
SectionEnd
