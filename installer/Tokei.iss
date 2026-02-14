; Inno Setup script for Tokei (app-only installer)

#define MyAppName "Tokei (CLI)"
#define MyAppVersion "0.8.2"
#define MyAppPublisher "Tokei"
#define MyAppExeName "Tokei.exe"
#define MyAppId "{{C8B7A6E4-5E8C-4D63-9A41-8A6B9B99A5B2}}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist-installer
OutputBaseFilename=Tokei-CLI-Setup-{#MyAppVersion}
SetupIconFile=..\assets\tokei.ico
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
UninstallDisplayIcon={app}\{#MyAppExeName}
UsedUserAreasWarning=no

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop icon"; Flags: unchecked

[Files]
Source: "..\dist\Tokei\*"; DestDir: "{app}"; Excludes: "node_modules\*,config.json,toggl-token.txt"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\assets\tokei.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\assets\tokei-shortcut.ico"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{userappdata}\Tokei"; Flags: uninsneveruninstall
Name: "{%USERPROFILE}\Pictures\Tokei"; Flags: uninsneveruninstall

[Icons]
Name: "{autoprograms}\{#MyAppName}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\tokei-shortcut.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon; IconFilename: "{app}\tokei-shortcut.ico"

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "TOKEI_USER_ROOT"; ValueData: "{userappdata}\Tokei"; Flags: uninsdeletevalue preservestringtype

[Code]
var
  RemoveUserData: Boolean;

const
  WM_SETTINGCHANGE = $001A;
  SMTO_ABORTIFHUNG = $0002;

function SendMessageTimeout(hWnd: Longint; Msg: Longint; wParam: Longint; lParam: string;
  fuFlags: Longint; uTimeout: Longint; var lpdwResult: Longint): Longint;
  external 'SendMessageTimeoutW@user32.dll stdcall';

procedure RefreshEnvironment;
var
  MsgResult: Longint;
begin
  SendMessageTimeout(HWND_BROADCAST, WM_SETTINGCHANGE, 0, 'Environment', SMTO_ABORTIFHUNG, 5000, MsgResult);
end;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
  NodeOk: Boolean;
begin
  NodeOk := Exec(ExpandConstant('{cmd}'), '/c where node', '', SW_HIDE, ewWaitUntilTerminated, ResultCode)
    and (ResultCode = 0);
  if not NodeOk then
    MsgBox('Node.js is required to run Tokei.'#13#10
      + 'Please install Node.js before running the application.'#13#10
      + 'https://nodejs.org/', mbInformation, MB_OK);
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  UserRoot: string;
  ReportsDir: string;
  ConfigPath: string;
  ReportsDirEsc: string;
  ConfigJson: string;
begin
  if CurStep = ssPostInstall then
  begin
    UserRoot := ExpandConstant('{userappdata}\Tokei');
    ReportsDir := ExpandConstant('{%USERPROFILE}\Pictures\Tokei');
    ConfigPath := AddBackslash(UserRoot) + 'config.json';

    if not FileExists(ConfigPath) then
    begin
      ReportsDirEsc := ReportsDir;
      StringChangeEx(ReportsDirEsc, '\', '\\', True);

      ConfigJson :=
        '{' + #13#10 +
        '  "anki_profile": "User 1",' + #13#10 +
        '  "timezone": "local",' + #13#10 +
        '  "theme": "dark-graphite",' + #13#10 +
        '  "output_dir": "' + ReportsDirEsc + '",' + #13#10 +
        '  "one_page": true,' + #13#10 +
        '  "anki_stats": { "require_fresh": true },' + #13#10 +
        '  "toggl": {' + #13#10 +
        '    "start_date": "auto",' + #13#10 +
        '    "refresh_days_back": 60,' + #13#10 +
        '    "refresh_buffer_days": 2,' + #13#10 +
        '    "chunk_days": 7,' + #13#10 +
        '    "baseline_hours": 0' + #13#10 +
        '  },' + #13#10 +
        '  "mokuro": { "volume_data_path": "" },' + #13#10 +
        '  "ttsu": { "data_dir": "" },' + #13#10 +
        '  "gsm": { "db_path": "auto" }' + #13#10 +
        '}' + #13#10;

      SaveStringToFile(ConfigPath, ConfigJson, False);
    end;

    RefreshEnvironment;
  end;
end;

function InitializeUninstall(): Boolean;
begin
  RemoveUserData := MsgBox(
    'Do you want to remove user data stored in %APPDATA%\Tokei ?',
    mbConfirmation, MB_YESNO) = IDYES;
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usUninstall) and RemoveUserData then
    DelTree(ExpandConstant('{userappdata}\Tokei'), True, True, True);
end;
