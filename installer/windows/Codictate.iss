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

; Must match Electrobun Updater: %LOCALAPPDATA%\{identifier}\{channel}\app
; (see node_modules/electrobun/.../Updater.ts runningAppBundlePath for win).
; If Inno installs under Programs\Codictate while updates apply here, shortcuts
; keep launching the old copy after an in-app update.
#define InstallRelDir GetEnv("CODICTATE_INNO_INSTALL_RELDIR")
#if InstallRelDir == ""
  #error CODICTATE_INNO_INSTALL_RELDIR must be set (e.g. app.codictate/stable/app)
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
DefaultDirName={localappdata}\{#InstallRelDir}
DefaultGroupName={#AppName}
UsePreviousAppDir=no
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
; The installer puts the `codictate` command line on the user's Path (docs/CLI.md), and
; this broadcasts the change so new terminals see it without signing out.
ChangesEnvironment=yes

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

[Code]
// The `codictate` command line (docs/CLI.md) ships at <install>\Resources\app\bin, where
// <install> is the app directory (%LOCALAPPDATA%\app.codictate\stable\app for stable).
// That directory goes on HKCU\Environment Path once, and comes off again on uninstall.
// In-app updates replace the files in the same directory, so the entry stays valid.
const
  EnvironmentKey = 'Environment';

function CliBinDir(): string;
begin
  Result := ExpandConstant('{app}\Resources\app\bin');
end;

function SamePathEntry(A, B: string): Boolean;
begin
  Result := CompareText(RemoveBackslashUnlessRoot(Trim(A)), RemoveBackslashUnlessRoot(Trim(B))) = 0;
end;

// Path with every entry naming Entry removed, other entries untouched.
function PathWithout(Path, Entry: string; var Found: Boolean): string;
var
  Rest, Part: string;
  P: Integer;
  First: Boolean;
begin
  Result := '';
  Found := False;
  First := True;
  Rest := Path;
  while Rest <> '' do
  begin
    P := Pos(';', Rest);
    if P = 0 then
    begin
      Part := Rest;
      Rest := '';
    end
    else
    begin
      Part := Copy(Rest, 1, P - 1);
      Rest := Copy(Rest, P + 1, Length(Rest));
    end;
    if SamePathEntry(Part, Entry) then
      Found := True
    else
    begin
      if not First then
        Result := Result + ';';
      Result := Result + Part;
      First := False;
    end;
  end;
end;

procedure AddCliToPath();
var
  Path, Unused: string;
  Found: Boolean;
begin
  // A Path that exists but does not read as a string is left alone: writing ours over it
  // would replace every entry the user has. Only a missing Path is created from scratch.
  if RegValueExists(HKCU, EnvironmentKey, 'Path') then
  begin
    if not RegQueryStringValue(HKCU, EnvironmentKey, 'Path', Path) then
    begin
      Log('Could not read the user Path, so ' + CliBinDir() + ' was not added to it');
      Exit;
    end;
  end
  else
    Path := '';
  Unused := PathWithout(Path, CliBinDir(), Found);
  if Found then
    Exit;
  if (Path <> '') and (Copy(Path, Length(Path), 1) <> ';') then
    Path := Path + ';';
  Path := Path + CliBinDir();
  if not RegWriteExpandStringValue(HKCU, EnvironmentKey, 'Path', Path) then
    Log('Could not add ' + CliBinDir() + ' to the user Path');
end;

procedure RemoveCliFromPath();
var
  Path, Remaining: string;
  Found: Boolean;
begin
  if not RegQueryStringValue(HKCU, EnvironmentKey, 'Path', Path) then
    Exit;
  Remaining := PathWithout(Path, CliBinDir(), Found);
  if not Found then
    Exit;
  if not RegWriteExpandStringValue(HKCU, EnvironmentKey, 'Path', Remaining) then
    Log('Could not remove ' + CliBinDir() + ' from the user Path');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    AddCliToPath();
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    RemoveCliFromPath();
end;
