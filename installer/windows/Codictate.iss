#define AppName GetEnv("CODICTATE_INNO_APP_NAME")
#if AppName == ""
  #define AppName "Codictate"
#endif

#define AppVersion GetEnv("CODICTATE_INNO_APP_VERSION")
#if AppVersion == ""
  #define AppVersion "0.0.0"
#endif

#define AppChannel GetEnv("CODICTATE_INNO_CHANNEL")
#if AppChannel == ""
  #define AppChannel "stable"
#endif

#define SourceDir GetEnv("CODICTATE_INNO_SOURCE_DIR")
#if SourceDir == ""
  #error CODICTATE_INNO_SOURCE_DIR must point at the built Windows app bundle directory
#endif

#define OutputDir GetEnv("CODICTATE_INNO_OUTPUT_DIR")
#if OutputDir == ""
  #define OutputDir "artifacts"
#endif

#define IconFile GetEnv("CODICTATE_INNO_ICON_FILE")
#if IconFile == ""
  #error CODICTATE_INNO_ICON_FILE must point at the Windows .ico file
#endif

#define AppSourceExeName GetEnv("CODICTATE_INNO_SOURCE_EXE_NAME")
#if AppSourceExeName == ""
  #define AppSourceExeName "launcher.exe"
#endif

#if AppChannel == "stable"
  #define AppId "app.codictate"
#else
  #define AppId "app.codictate." + AppChannel
#endif
#define Publisher "Codictate"
#define AppExeName "launcher.exe"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
AppPublisherURL=https://github.com/EmilLykke/codictate
AppSupportURL=https://github.com/EmilLykke/codictate/issues
AppUpdatesURL=https://github.com/EmilLykke/codictate/releases
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename={#AppChannel}-windows-x64-{#AppName}-Setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\Resources\app.ico
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
CloseApplications=yes
RestartApplications=no
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\bin\{#AppSourceExeName}"; DestDir: "{app}\bin"; DestName: "{#AppExeName}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\bin\{#AppExeName}"; WorkingDir: "{app}\bin"; IconFilename: "{app}\Resources\app.ico"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\bin\{#AppExeName}"; WorkingDir: "{app}\bin"; IconFilename: "{app}\Resources\app.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\bin\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent
