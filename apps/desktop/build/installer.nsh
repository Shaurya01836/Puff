; Extra steps for the Windows installer (electron-builder includes this file automatically).
;
; When Puff is already installed, say so and say where, so running a newer installer is plainly an
; update: it goes into the same folder (the installer itself reads that folder from the registry and
; removes the old version first), and the person's projects and memory live elsewhere and are kept.
!macro customInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $1 HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  ${If} $0 != ""
  ${AndIfNot} ${Silent}
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Puff $1 is already installed in:$\r$\n$0$\r$\n$\r$\nSetup will update it to ${VERSION} in the same folder. Your projects and memory are kept.$\r$\n$\r$\nIf Puff is open, Setup will ask you to close it first." IDOK puff_update_go
    Quit
    puff_update_go:
  ${EndIf}
!macroend
