function Get-MinidumpCrashSummary {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $stream = $null
    $reader = $null
    try {
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        $reader = [System.IO.BinaryReader]::new($stream)
        $length = [uint64]$stream.Length
        if ($length -lt 32) { return [pscustomobject]@{ status = 'invalid-header' } }
        if ($reader.ReadUInt32() -ne 0x504d444d) { return [pscustomobject]@{ status = 'invalid-header' } }
        [void]$reader.ReadUInt32()
        $streamCount = [uint64]$reader.ReadUInt32()
        $directoryRva = [uint64]$reader.ReadUInt32()
        if ($streamCount -gt 256 -or $streamCount -eq 0) { return [pscustomobject]@{ status = 'invalid-directory' } }
        $directoryBytes = $streamCount * 12
        if ($directoryRva -lt 32 -or $directoryRva -gt $length -or $directoryBytes -gt ($length - $directoryRva)) {
            return [pscustomobject]@{ status = 'invalid-directory' }
        }

        $streams = @{}
        $stream.Position = [int64]$directoryRva
        for ($i = 0; $i -lt [int]$streamCount; $i++) {
            $type = $reader.ReadUInt32()
            $dataSize = [uint64]$reader.ReadUInt32()
            $rva = [uint64]$reader.ReadUInt32()
            if ($rva -gt $length -or $dataSize -gt ($length - $rva)) {
                return [pscustomobject]@{ status = 'invalid-stream' }
            }
            if ($type -in @(4, 6)) {
                if ($streams.ContainsKey([string]$type)) { return [pscustomobject]@{ status = 'invalid-stream' } }
                $streams[[string]$type] = @{ rva = $rva; size = $dataSize }
            }
        }
        if (-not $streams.ContainsKey('6')) { return [pscustomobject]@{ status = 'no-exception-stream' } }
        if (-not $streams.ContainsKey('4')) { return [pscustomobject]@{ status = 'no-module-stream' } }

        $exception = $streams['6']
        if ($exception.size -lt 168) { return [pscustomobject]@{ status = 'invalid-exception-stream' } }
        $stream.Position = [int64]($exception.rva + 8)
        $exceptionCode = $reader.ReadUInt32()
        [void]$reader.ReadUInt32()
        [void]$reader.ReadUInt64()
        $exceptionAddress = $reader.ReadUInt64()

        $modules = $streams['4']
        if ($modules.size -lt 4) { return [pscustomobject]@{ status = 'invalid-module-stream' } }
        $stream.Position = [int64]$modules.rva
        $moduleCount = [uint64]$reader.ReadUInt32()
        if ($moduleCount -gt 100000 -or ($moduleCount * 108) -gt ($modules.size - 4)) {
            return [pscustomobject]@{ status = 'invalid-module-stream' }
        }

        $faultingModule = $null
        for ($i = 0; $i -lt [int]$moduleCount; $i++) {
            $entryOffset = [uint64]$modules.rva + 4 + ($i * 108)
            $stream.Position = [int64]$entryOffset
            $base = $reader.ReadUInt64()
            $imageSize = [uint64]$reader.ReadUInt32()
            $stream.Position = [int64]($entryOffset + 20)
            $nameRva = [uint64]$reader.ReadUInt32()
            if ($imageSize -eq 0 -or $base -gt ([uint64]::MaxValue - $imageSize)) { continue }
            if ($exceptionAddress -lt $base -or $exceptionAddress -ge ($base + $imageSize)) { continue }
            if ($nameRva -gt ($length - 4)) { return [pscustomobject]@{ status = 'invalid-module-name' } }
            $stream.Position = [int64]$nameRva
            $nameLength = [uint64]$reader.ReadUInt32()
            if (($nameLength -band 1) -ne 0 -or $nameLength -gt 8192 -or $nameLength -gt ($length - $nameRva - 4)) {
                return [pscustomobject]@{ status = 'invalid-module-name' }
            }
            $nameBytes = $reader.ReadBytes([int]$nameLength)
            if ($nameBytes.Length -ne [int]$nameLength) { return [pscustomobject]@{ status = 'invalid-module-name' } }
            $fullName = [System.Text.Encoding]::Unicode.GetString($nameBytes)
            $faultingModule = ($fullName -split '[\\/]')[-1]
            if (-not $faultingModule -or $faultingModule.Length -gt 260 -or $faultingModule -match '[\x00-\x1f\x7f]') {
                return [pscustomobject]@{ status = 'invalid-module-name' }
            }
            break
        }

        return [pscustomobject]@{
            status = 'parsed'
            exceptionCode = ('0x{0:X8}' -f $exceptionCode)
            exceptionAddress = ('0x{0:X16}' -f $exceptionAddress)
            faultingModuleName = $faultingModule
        }
    } catch {
        return [pscustomobject]@{ status = 'invalid-dump' }
    } finally {
        if ($reader) { $reader.Dispose() } elseif ($stream) { $stream.Dispose() }
    }
}
