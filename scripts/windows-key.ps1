param([ValidateSet('Read','Setup','RoundTripTest')][string]$Mode = 'Setup')
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    $entropy = [Text.Encoding]::UTF8.GetBytes('MyTube.YouTubeKey.v1')
    if ($Mode -eq 'RoundTripTest') {
        $sample = [Text.Encoding]::UTF8.GetBytes('SYNTHETIC_YOUTUBE_KEY_NEVER_REAL_12345')
        $encrypted = [Security.Cryptography.ProtectedData]::Protect($sample, $entropy, $scope)
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $entropy, $scope)
        if ([Convert]::ToBase64String($sample) -ne [Convert]::ToBase64String($plain)) { throw 'Failed' }
        $rejected = $false
        try { [void][Security.Cryptography.ProtectedData]::Unprotect($encrypted, [Text.Encoding]::UTF8.GetBytes('Wrong purpose'), $scope) }
        catch { $rejected = $true }
        if (!$rejected) { throw 'Integrity test failed' }
        [Array]::Clear($plain, 0, $plain.Length)
        [Console]::Out.Write('DPAPI_ROUNDTRIP_OK')
        exit 0
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.Name -match '\\CodexSandbox') { throw 'Wrong account' }
    $directory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MyTube\Credentials'
    $path = Join-Path $directory 'youtube-key.dpapi'
    foreach ($candidate in @((Split-Path $directory), $directory, $path)) {
        if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid path' }
    }
    if ($Mode -eq 'Read') {
        if (!(Test-Path -LiteralPath $path)) { exit 0 }
        if ((Get-Item -LiteralPath $path).Length -gt 16384) { throw 'Invalid size' }
        $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path), $entropy, $scope)
        try {
            $key = [Text.Encoding]::UTF8.GetString($plain)
            if ($key -cnotmatch '^[A-Za-z0-9_-]{20,256}$') { throw 'Invalid key' }
            # Private pipe to connector only. Never run Read as a diagnostic.
            [Console]::Out.Write($key)
        } finally { [Array]::Clear($plain, 0, $plain.Length); $key = $null }
        exit 0
    }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $form = New-Object Windows.Forms.Form
    $form.Text = 'MyTube - Windows-protected YouTube key'
    $form.ClientSize = New-Object Drawing.Size(560, 235)
    $form.StartPosition = 'CenterScreen'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox = $false
    $label = New-Object Windows.Forms.Label
    $label.Text = "Paste your own YouTube API key. Windows encrypts it for this account.`nNo key is sent to ChatGPT or saved in the browser."
    $label.SetBounds(20,20,520,45)
    $input = New-Object Windows.Forms.TextBox
    $input.UseSystemPasswordChar = $true
    $input.MaxLength = 256
    $input.SetBounds(20,75,520,28)
    $status = New-Object Windows.Forms.Label
    $status.SetBounds(20,115,520,50)
    $status.Text = 'Saving replaces the protected key. Existing .secrets files are unchanged.'
    $save = New-Object Windows.Forms.Button
    $save.Text = 'Encrypt and save'
    $save.SetBounds(290,180,150,32)
    $cancel = New-Object Windows.Forms.Button
    $cancel.Text = 'Cancel'
    $cancel.SetBounds(450,180,90,32)
    $cancel.Add_Click({ $form.Close() })
    $save.Add_Click({
        try {
            $value = $input.Text.Trim()
            if ($value -cnotmatch '^[A-Za-z0-9_-]{20,256}$') { $status.Text = 'Enter a valid API key (no spaces or quotes).'; return }
            [IO.Directory]::CreateDirectory($directory) | Out-Null
            $acl = New-Object Security.AccessControl.DirectorySecurity
            $acl.SetAccessRuleProtection($true, $false)
            $acl.SetOwner($identity.User)
            foreach ($sid in @($identity.User, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
                $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
                $acl.AddAccessRule($rule)
            }
            Set-Acl -LiteralPath $directory -AclObject $acl
            $bytes = [Text.Encoding]::UTF8.GetBytes($value)
            try { $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope) }
            finally { [Array]::Clear($bytes, 0, $bytes.Length); $value = $null; $input.Clear() }
            $temporary = Join-Path $directory ([Guid]::NewGuid().ToString() + '.tmp')
            try {
                [IO.File]::WriteAllBytes($temporary, $encrypted)
                if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temporary, $path, $null) }
                else { [IO.File]::Move($temporary, $path) }
            } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
            $status.Text = 'Saved with Windows protection. You can close this window and search.'
            $save.Enabled = $false
            $cancel.Text = 'Close'
        } catch { $input.Clear(); $status.Text = 'Could not save securely. Your previous key was preserved.' }
    })
    $form.Controls.AddRange(@($label,$input,$status,$save,$cancel))
    $form.AcceptButton = $save
    $form.CancelButton = $cancel
    try { [void]$form.ShowDialog() } finally { $input.Clear(); $form.Dispose() }
} catch { [Console]::Error.Write('WINDOWS_KEY_UNAVAILABLE'); exit 1 }
