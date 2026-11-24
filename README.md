# Planta Helper

Protótipo estático; o motor geométrico (`generator.mjs`) usa OR-Tools CP-SAT em WebAssembly e roda no navegador ou no Node. Um motor heurístico puro em JavaScript oferece uma alternativa rápida.
Na página, os exemplos podem ser carregados e editados. “Salvar arquivo” baixa as entradas como JSON e “Abrir arquivo” as restaura para edição; as opções só são recalculadas ao gerar. A chave “Tema escuro”, no menu à esquerda, alterna o tema; sem escolha salva, a página segue a preferência do sistema.

## Interface de máquina

Envie um objeto JSON para stdin:

```sh
node cli.mjs < entrada.json
```

Entrada:

```json
{
  "rooms": [
    {"name":"quarto1","minArea":12,"maxArea":16,"minSide":2.4,"exterior":true,"links":["corredor"]},
    {"name":"corredor","corridor":true,"minArea":2,"maxArea":4,"minSide":1,"exterior":true,"links":["quarto1"]},
    {"name":"vazio","void":true,"minArea":2,"maxArea":4,"minSide":1,"links":[]}
  ]
}
```

As conexões devem ser simétricas. Informe áreas e `minSide` para todos os cômodos; use `"corridor": true` para marcar o corredor e `"void": true` para marcar uma área vazada (aberta). `"exterior": true` exige que o cômodo toque o perímetro externo ou uma área vazada; um vazado não precisa de conexões. O campo opcional `"facades"` lista as fachadas em que o cômodo precisa de abertura, com um ou mais de `"north"`, `"south"`, `"east"`, `"west"`; norte é o topo do desenho (`y` mínimo), sul o fim (`y` máximo), oeste a esquerda (`x` mínimo) e leste a direita (`x` máximo). O motor exige cobertura completa do retângulo externo e, para a opção de maior casa, maximiza a área total antes de minimizar a área do corredor. O campo opcional `"engine"` escolhe o motor: `"cp-sat"` (padrão, exato, exige retângulo) ou `"loose"` (formato livre). Envelopes antigos com `"loose-rect"` são aceitos e tratados como `"loose"`. O campo opcional `"warm"` reaproveita a geração anterior como ponto de partida: um mapa do `id` de cada objetivo para o `layout` que ele devolveu. É apenas uma dica para os motores exatos — nunca volta como resposta, e uma entrada desatualizada (cômodo renomeado, área alterada) é reparada ou ignorada pelo solver. A página guarda esse mapa no `localStorage`; o CLI aceita o mesmo campo na entrada. O CLI também aceita diretamente o envelope `.json` baixado pelo botão “Salvar arquivo”. A resposta é JSON: `{ "ok": true, "engine": "...", "options": [...] }` ou `{ "ok": false, "error": "..." }`. Cada opção tem um `id` estável, `status` e `layout`; coordenadas e dimensões são inteiros em células de 10 cm (`x`, `y`, `w`, `h`). Quando o motor livre retangular devolve um retângulo externo maior que os cômodos, a opção também traz `bounds` com os limites desse retângulo. Cada cômodo do `layout` traz `touchesExterior`, que indica se ele toca o perímetro externo ou um vazado, e `void`, que repete a flag de área vazada. O `status` é `optimal` ou `feasible` quando o CP-SAT produz a planta, `loose` quando a resposta vem da caminhada heurística, e `infeasible` (impossível comprovado) ou `unknown` (indeterminado no orçamento) quando nenhuma planta existe ou foi encontrada. A resposta também traz `alternatives`: outras plantas válidas, uma por grafo de contatos (dois cômodos com pelo menos 1 m de parede compartilhada contam uma aresta), ordenadas por objetivo e sem repetir os grafos das três opções principais. A página mostra as três opções e revela as demais pelo botão “Mostrar mais opções”.

## Motores

- **CP-SAT** (`cp-sat`): modelo exato de programação por restrições; exige cobertura total de um retângulo externo. Recebe como dica o melhor arranjo do heurístico livre e, quando existe, a planta da geração anterior (`"warm"`). O limite de tempo é 8 s por objetivo (3 s no mínimo, 0,6 s por cômodo; `PLANTA_SOLVE_SECONDS` sobrepõe) — o solver gasta o orçamento inteiro, salvo se provar o ótimo antes. Para a maior casa, o motor enumera as caixas de área Σmáxima e aceita a primeira que ladrilha: o teto é provado por construção, em segundos.
- **Livre** (`loose`): aceita formatos em L ou irregulares. O modelo exato solto (retângulo com espaços livres) responde primeiro; a caminhada heurística é o piso garantido quando o modelo não decide; quando nem a caminhada acha nada, o status é `infeasible` ou `unknown`, nunca um card vazio. A caminhada também alimenta a dica do `cp-sat` e as `alternatives` de todos os motores; cada planta guardada tem um grafo de contatos diferente.

Os dois motores devolvem o mesmo formato. O `cp-sat` valida com o critério apertado (retângulo ladrilhado); o `loose` valida qualquer contorno conexo sem vãos fechados. Ambos passam pelo validador comum (`layout.mjs`), que rejeita sobreposições, paredes insuficientes e perímetro externo não atendido.

Instale as dependências com `npm install` e teste o motor com `npm test`. A suíte usa os casos de `tests/casa_prado*.json` — uma casa com corredor, jardim vazado e 12 cômodos, mais duas variantes mais difíceis (fachadas obrigatórias e 14 cômodos) — como casos complexos de validação dos motores. Nos casos difíceis o orçamento curto da suíte pode não fechar todos os objetivos; aí o card traz `unknown`, `infeasible` ou `failed`, nunca uma planta inventada ou um status de sucesso sem planta. `npm run bench` roda todos os motores nesse caso e imprime tempo, status, área, caixa e validação por objetivo; use-o para comparar mudanças nos solvers. Qualquer arquivo de entrada ou envelope serve: `npm run bench -- tests/casa_prado_b.json`.

## Publicação

O site é publicado no GitHub Pages pelo workflow `.github/workflows/pages.yml`: a cada push na `main` ele instala as dependências, copia a página e os arquivos do `cp-sat-wasm` (`browser` e `wasm`) para um artefato e publica em <https://marcelodaher.github.io/planta_helper/>. O import map do `index.html` é relativo, então a página funciona tanto na raiz quanto em um subdiretório. Para rodar localmente, sirva a raiz do projeto por HTTP (`npx serve` ou `python3 -m http.server`); `file://` não carrega os módulos.

## Decisões

- **Princípio de módulos:** tudo que decide uma planta vive em código sem interface (`layout.mjs`, `engines.mjs`, `generator.mjs`) e é exercitável sem navegador por `node cli.mjs`, `npm test` e `npm run bench`. `app.js` apenas renderiza e transporta (workers, `localStorage`); nenhum comportamento de motor pode existir só na página.
- A planta é uma grade de 10 cm e todos os cômodos são retângulos alinhados a essa grade.
- Uma solução válida dos motores retangulares cobre completamente um único retângulo externo, sem sobreposição nem áreas mortas; o motor livre retangular aceita um retângulo com espaços livres; o motor livre aceita contornos conexos em L ou irregulares, sem vãos fechados.
- Fachadas nomeadas fixam aquele lado do cômodo à parede correspondente da casa. Como o nome tem significado geográfico, a planta nunca é girada na interface e o desenho mostra um indicador de norte; o motor exato também deixa de impor `largura >= altura` quando há fachadas em jogo.
- Todo cômodo regular informa área mínima, área máxima e lado mínimo. Duas flags são independentes: “Exige contato com a área externa” (`exterior`) obriga o cômodo a tocar o perímetro externo ou uma área vazada; “É área externa (vazado)” (`void`) marca um cômodo como área aberta, e os cômodos que tocam esse vazado passam a contar com área externa.
- A flag de contato com a área externa vem marcada para cômodos comuns e desmarcada para corredores e vazados.
- Conexões representam paredes compartilhadas de pelo menos 1 m (espaço para uma porta), são sempre bidirecionais, devem ser simétricas e são editadas por checkboxes. Conexões são opcionais: dois cômodos sem conexão podem se tocar, mas dois cômodos conectados precisam obrigatoriamente compartilhar uma parede.
- O corredor é um cômodo comum com a flag `"corridor": true`, área mínima/máxima e lado mínimo; por padrão não precisa tocar o exterior.
- Para a maior casa, o objetivo principal é maximizar a área total do retângulo externo; em empate, minimizar a área do corredor.
- Para a menor casa, o objetivo é minimizar a área total do retângulo externo; a área do corredor é o desempate.
- O motor usa OR-Tools CP-SAT em WebAssembly para produzir soluções viáveis ou ótimas comprovadas. No navegador ele roda em um worker e é single-thread (Pages não envia cabeçalhos COOP/COEP); no Node o mesmo wasm é multi-thread e usa todas as cores por padrão — mais threads não reduzem o tempo de parede com orçamento fixo, melhoram o incumbente. `PLANTA_WORKERS` fixa o número para medições reproduzíveis.
- O modelo exato fixa `largura >= altura` do retângulo externo: girar a planta não muda nada, e a restrição corta metade da simetria. A dica recebida é girada e deslocada para a origem antes de entrar no modelo.
- O motor heurístico nunca devolve planta inválida: cada arranjo passa pelo validador livre e o status é `loose`. Quando a caminhada não acha nada (fuzzing mostrou que isso acontece em grafos densos mesmo com planta existente), o motor recorre ao modelo exato solto; se nem esse decidir, o status é `infeasible` ou `unknown` — nunca um card vazio sem explicação.
- Dois motores selecionáveis na interface: CP-SAT (exato, retângulo ladrilhado) e livre (formatos não retangulares, com a caminhada heurística como piso); todos devolvem o mesmo formato e passam pelo validador adequado. O antigo `loose-rect` foi fundido no `loose`: seu modelo exato solto é a primeira tentativa do motor livre.
- O motor livre retangular devolve `bounds`, os limites do retângulo externo, para que a interface mostre também o espaço livre dentro da casa.
- A escolha do motor é salva no envelope JSON e restaurada ao abrir o arquivo.
- A lista de cômodos é reordenável por arraste; adicionar e editar usam o mesmo diálogo, com presets para cômodo e corredor.
- Arrastar um cômodo para “× Remover cômodo” o remove e limpa as conexões correspondentes.
- Cada cômodo tem uma cor escolhida no diálogo; ela é persistida no JSON e usada na visualização da planta.
- Salvar/abrir usa JSON versionado, e o CLI aceita tanto a entrada direta quanto o envelope salvo.
