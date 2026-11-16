# Polifonia Eletroacústica

Editor para compor e ouvir **texturas polifônicas eletroacústicas** em
camadas. Cada camada é desenhada como um polígono no plano tempo × altura e
preenchida com eventos sonoros gerados a partir de regras de ritmo,
densidade, altura e timbre; relações entre camadas permitem coordenar ritmo,
direção e intervalos.

**Criado por Rogério Tavares Constante.**

### ▶ [Abrir o editor no navegador](https://rogerioconstante.github.io/polifonia-eletroacustica/)

Funciona em navegadores modernos, sem instalação.

## Funcionalidades

- **Tipos de objeto:** notas pontuais, glissandos/trajetórias e som
  contínuo.
- **Ritmo:** pulso, andamento, densidade, padrão rítmico cíclico (1 = ataque,
  0 = pausa), duração e aleatoriedade.
- **Altura:** livre, por semitons, por conjunto de classes de altura ou por
  série; notação por nome (C3 = dó central, `C#3`, `mib4`), MIDI ou Hz.
- **Timbre:** senoidal, aditiva, FM, granular, ruído filtrado ou arquivos de
  áudio da pasta `audios/`; envelope ADSR.
- **Relações entre camadas** (ritmo, direção, intervalar), mudo/solo,
  dinâmica, pan e reverb por camada.
- **Projetos** salvos e abertos em JSON (com salvamento automático no
  navegador) e **exportação em WAV** (16/24 bits, 44,1/48 kHz), da composição
  inteira ou de uma camada.
- Desfazer/refazer e atalhos de teclado (`V`, `P`, `Del`, `Ctrl+D`, `Ctrl+Z`,
  `Ctrl+S`, `Ctrl+E`…).

## Usar no próprio computador

1. Baixe o repositório (**Code ▸ Download ZIP**) e descompacte.
2. Rode o servidor local na pasta (os módulos JavaScript e os arquivos de
   áudio exigem HTTP):
   - **Linux/macOS:** `./iniciar-servidor.sh` (abre o navegador sozinho;
     `./parar-servidor.sh` encerra);
   - **qualquer sistema com Python 3:** `python3 servidor-sem-cache.py` e abra
     <http://localhost:8880/>.

### Usar suas próprias amostras

Coloque arquivos de áudio (`.wav`, `.flac`, `.mp3`, `.ogg`…) na pasta
`audios/` e clique em **↻** no editor. Com o servidor local a lista é lida
automaticamente; para o site publicado, inclua também o nome do arquivo em
[`audios/lista.json`](audios/lista.json).

## Créditos e licenças

Código: © 2026 Rogério Tavares Constante, licença [GPL-3.0](LICENSE).
Amostras de áudio: ver [CREDITOS.md](CREDITOS.md).

## Veja também

- [Stretto Fuga — Calculadora de Intervalos](https://rogerioconstante.github.io/stretto-fuga/)
- [Exercícios de Tratamentos de Dissonância](https://rogerioconstante.github.io/tratamentos-de-dissonancia/)
- [Ditado de Movimento das Vozes](https://rogerioconstante.github.io/ditado-movimento-de-vozes/)
  e [Ditado de Intervalos](https://rogerioconstante.github.io/ditado-intervalos/)

## Autor

Prof. Rogério Tavares Constante (UFRJ). Desenvolvido no âmbito do projeto
*Harmonia e Contraponto*.

Sugestões e relatos de problemas são bem-vindos na aba **Issues**.
