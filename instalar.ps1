# ALRIX Kit - instalador para Windows, em PowerShell.
#
# Numa linha, sem baixar nada antes:
#   irm https://raw.githubusercontent.com/alrixbr/alrix-kit/main/instalar.ps1 | iex
#
# Com a pasta do kit ja no computador:
#   .\instalar.ps1               instala
#   .\instalar.ps1 --simular     so mostra o que faria
#   .\instalar.ps1 --desfazer    desfaz tudo
#   .\instalar.ps1 --ajuda       todas as opcoes
#
# O que este script faz: confere se o Node, o Claude Code e o Git estao instalados, diz como instalar o que
# faltar e chama o instalar.mjs, que faz o trabalho de verdade. Rodado sozinho, pela linha do irm, ele baixa o
# kit do GitHub para uma pasta temporaria, roda de la e apaga a pasta no fim.
#
# Tres cuidados deste arquivo, todos por causa da linha do irm:
# 1. So tem caracteres ASCII e nao tem a marca de ordem de bytes no comeco: com a marca, o PowerShell deixa de
#    ler a primeira linha como comentario. As letras com acento dos textos vem das variaveis logo abaixo.
# 2. Nao usa "exit" quando roda pela linha do irm, para nao fechar a janela de quem esta instalando.
# 3. Devolve as preferencias da sessao como estavam.
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Opcoes
)

$alrixAntes = @{ Erro = $ErrorActionPreference; Progresso = $ProgressPreference; Saida = $null }
# Para o texto em portugues do instalar.mjs sair com os acentos certos.
try { $alrixAntes.Saida = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$atil = [string][char]0x00E3    # a com til
$eagudo = [string][char]0x00E9  # e com acento agudo
$meio = [string][char]0x00B7    # ponto do meio
$certo = [string][char]0x2714   # sinal de conferido

$Falta = { param([string] $texto) Write-Host "  ! $texto" -ForegroundColor Yellow }

$Repositorio = if ($env:ALRIX_KIT_REPO) { $env:ALRIX_KIT_REPO } else { 'alrixbr/alrix-kit' }
$codigo = 1
$temporaria = $null

try {
    do {
        Write-Host ''
        Write-Host "ALRIX Kit $meio conferindo o que o instalador precisa"

        # --- Node
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
            & $Falta "N${atil}o achei o Node neste computador."
            & $Falta 'Instale o Node de um destes jeitos e rode este comando de novo:'
            & $Falta '  winget install OpenJS.NodeJS.LTS'
            & $Falta '  ou baixe em https://nodejs.org'
            & $Falta 'Depois de instalar, feche e abra o PowerShell para o Windows enxergar o Node.'
            break
        }
        $versaoNode = (& node --version).TrimStart('v')
        if ([int]($versaoNode.Split('.')[0]) -lt 18) {
            & $Falta "O Node $versaoNode $eagudo antigo demais: o instalador precisa do 18 ou mais novo."
            & $Falta '  winget upgrade OpenJS.NodeJS.LTS'
            break
        }
        Write-Host "  $certo Node $versaoNode"

        # --- Claude Code
        if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
            & $Falta "N${atil}o achei o Claude Code neste computador."
            & $Falta 'Instale com este comando do PowerShell e rode este comando de novo:'
            & $Falta '  irm https://claude.ai/install.ps1 | iex'
            & $Falta 'Depois de instalar, feche e abra o PowerShell.'
            break
        }
        $versaoClaude = ((& claude --version) -join ' ').Trim()
        Write-Host "  $certo Claude Code $versaoClaude"

        # --- onde esta o instalar.mjs
        $pasta = $PSScriptRoot
        $extra = @()
        if (-not $pasta -or -not (Test-Path (Join-Path $pasta 'instalar.mjs'))) {
            # Sem a pasta do kit, os plugins vem do GitHub, e quem baixa e o Claude Code, pelo Git.
            if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
                & $Falta "N${atil}o achei o Git neste computador. O Claude Code usa o Git para baixar os plugins."
                & $Falta 'Instale com este comando e rode este comando de novo:'
                & $Falta '  winget install Git.Git'
                & $Falta 'Depois de instalar, feche e abra o PowerShell.'
                break
            }
            Write-Host "  $certo Git"
            Write-Host ''
            Write-Host "Baixando o kit de https://github.com/$Repositorio ..."
            $temporaria = Join-Path ([System.IO.Path]::GetTempPath()) ('alrix-kit-' + [System.Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $temporaria | Out-Null
            try {
                try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
                $zip = Join-Path $temporaria 'kit.zip'
                Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repositorio/archive/refs/heads/main.zip" -OutFile $zip
                # Abre o zip pelo .NET, que existe igual no PowerShell 5.1 e no 7 (o Expand-Archive varia entre eles).
                Add-Type -AssemblyName System.IO.Compression.FileSystem
                [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, (Join-Path $temporaria 'kit'))
                $temporariaKit = Join-Path $temporaria 'kit'
                $pasta = (Get-ChildItem -Path $temporariaKit -Directory | Select-Object -First 1).FullName
            } catch {
                & $Falta "N${atil}o consegui baixar o kit. Confira a internet e rode este comando de novo."
                & $Falta "Detalhe: $($_.Exception.Message)"
                break
            }
            if (-not $pasta -or -not (Test-Path (Join-Path $pasta 'instalar.mjs'))) {
                & $Falta "O arquivo baixado n${atil}o trouxe o instalador. Rode este comando de novo."
                break
            }
            $extra = @('--github', $Repositorio)
        }

        Write-Host ''
        & node (Join-Path $pasta 'instalar.mjs') @extra @Opcoes
        $codigo = $LASTEXITCODE
    } while ($false)
} finally {
    if ($temporaria) { Remove-Item -Recurse -Force $temporaria -ErrorAction SilentlyContinue }
    $ErrorActionPreference = $alrixAntes.Erro
    $ProgressPreference = $alrixAntes.Progresso
    if ($alrixAntes.Saida) { try { [Console]::OutputEncoding = $alrixAntes.Saida } catch { } }
}

# Rodado como arquivo, devolve o codigo de saida; pela linha do irm, so termina e a janela fica aberta.
if ($PSCommandPath -and ((Split-Path -Leaf $PSCommandPath) -eq 'instalar.ps1')) { exit $codigo }
