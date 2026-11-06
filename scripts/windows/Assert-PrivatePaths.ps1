[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$StateDir,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$TokenFile,
    [switch]$ProtectState,
    [switch]$ProtectSecrets
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
try {
    $stateFull = [IO.Path]::GetFullPath($StateDir).TrimEnd('\')
    $configFull = [IO.Path]::GetFullPath($ConfigPath)
    $tokenFull = [IO.Path]::GetFullPath($TokenFile)
    if ((Split-Path -Parent $configFull) -ine $stateFull -or (Split-Path -Parent $tokenFull) -ine $stateFull) { throw 'PRIVATE_PATH_REQUIRED' }
    $remoteToken = Join-Path (Split-Path -Parent $stateFull) 'remote-access.token'
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $allowed = @($owner.Value, $system.Value, 'S-1-5-32-544')

    function Assert-NoReparsePath([string]$LiteralPath) {
        $current = $LiteralPath
        while ($current) {
            if (Test-Path -LiteralPath $current) {
                $component = Get-Item -LiteralPath $current -Force
                if (($component.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PRIVATE_PATH_REPARSE_POINT' }
            }
            $parent = [IO.Path]::GetDirectoryName($current.TrimEnd('\'))
            if (-not $parent -or $parent -eq $current) { break }
            $current = $parent
        }
    }
    foreach ($knownPath in @($stateFull, $configFull, $tokenFull, $remoteToken)) { Assert-NoReparsePath $knownPath }

    function Set-PrivateAcl([string]$LiteralPath, [bool]$Directory) {
        $item = Get-Item -LiteralPath $LiteralPath -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PRIVATE_PATH_REPARSE_POINT' }
        if ($Directory) {
            $acl = [Security.AccessControl.DirectorySecurity]::new()
            $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        } else {
            $acl = [Security.AccessControl.FileSecurity]::new()
            $inherit = [Security.AccessControl.InheritanceFlags]::None
        }
        $acl.SetOwner($owner)
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($sid in @($owner, $system)) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
            $acl.AddAccessRule($rule)
        }
        # Use .NET Framework ACL methods so inherited PowerShell 7 module paths do
        # not make Set-Acl unavailable in a Windows PowerShell 5.1 child process.
        if ($Directory) { [IO.Directory]::SetAccessControl($LiteralPath, $acl) }
        else { [IO.File]::SetAccessControl($LiteralPath, $acl) }
    }
    function Assert-PrivateAcl([string]$LiteralPath) {
        if (-not (Test-Path -LiteralPath $LiteralPath)) { return }
        $item = Get-Item -LiteralPath $LiteralPath -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PRIVATE_PATH_REPARSE_POINT' }
        $acl = if ($item.PSIsContainer) { [IO.Directory]::GetAccessControl($LiteralPath) } else { [IO.File]::GetAccessControl($LiteralPath) }
        foreach ($rule in $acl.Access) {
            if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
                $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
                if ($allowed -notcontains $sid) { throw 'PRIVATE_ACL_REQUIRED' }
            }
        }
    }
    if ($ProtectState) { Set-PrivateAcl $stateFull $true }
    if ($ProtectSecrets) {
        # These are the only files this operation changes. No contents are read.
        foreach ($knownFile in @($remoteToken, $tokenFull)) {
            if (Test-Path -LiteralPath $knownFile -PathType Leaf) { Set-PrivateAcl $knownFile $false }
        }
    }
    $checkPaths = @($stateFull, $configFull)
    if (-not $ProtectState) { $checkPaths += @($tokenFull, $remoteToken) }
    foreach ($knownPath in $checkPaths) { Assert-PrivateAcl $knownPath }
    exit 0
} catch {
    [Console]::Error.WriteLine('PRIVATE_ACL_REQUIRED')
    exit 1
}
