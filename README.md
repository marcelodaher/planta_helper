# Planta Helper

Protótipo estático; o motor geométrico (`generator.mjs`) usa OR-Tools CP-SAT em WebAssembly e roda no navegador ou no Node. Dois motores heurísticos puros em JavaScript oferecem alternativas rápidas.
Na página, os exemplos podem ser carregados e editados. “Salvar arquivo” baixa as entradas como JSON e “Abrir arquivo” as restaura para edição; as opções só são recalculadas ao gerar.

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

As conexões devem ser simétricas. Informe áreas e `minSide` para todos os cômodos; use `"corridor": true` para marcar o corredor e `"void": true` para marcar uma área vazada (aberta). `"exterior": true` exige que o cômodo toque o perímetro externo ou uma área vazada; um vazado não precisa de conexões. O campo opcional `"facades"` lista as fachadas em que o cômodo precisa de abertura, com um ou mais de `"north"`, `"south"`, `"east"`, `"west"`; norte é o topo do desenho (`y` mínimo), sul o fim (`y` máximo), oeste a esquerda (`x` mínimo) e leste a direita (`x` máximo). O motor exige cobertura completa do retângulo externo e, para a opção de maior casa, maximiza a área total antes de minimizar a área do corredor. O campo opcional `"engine"` escolhe o motor: `"cp-sat"` (padrão, exato), `"loose-rect"` (exato com espaços livres), `"greedy"` (guloso), `"cut"` (cortes no grafo) ou `"loose"` (formato livre). O CLI também aceita diretamente o envelope `.json` baixado pelo botão “Salvar arquivo”. A resposta é JSON: `{ "ok": true, "engine": "...", "options": [...] }` ou `{ "ok": false, "error": "..." }`. Cada opção tem um `id` estável, `status` e `layout`; coordenadas e dimensões são inteiros em células de 10 cm (`x`, `y`, `w`, `h`). Quando o motor livre retangular devolve um retângulo externo maior que os cômodos, a opção também traz `bounds` com os limites desse retângulo. Cada cômodo do `layout` traz `touchesExterior`, que indica se ele toca o perímetro externo ou um vazado, e `void`, que repete a flag de área vazada. O `status` é `optimal` ou `feasible` no motor exato, `heuristic` nos motores retangulares rápidos, `loose` no motor livre e `failed` quando nenhum arranjo válido é encontrado. A resposta também traz `alternatives`: outras plantas válidas, uma por grafo de contatos (dois cômodos com pelo menos 1 m de parede compartilhada contam uma aresta), ordenadas por objetivo e sem repetir os grafos das três opções principais. A página mostra as três opções e revela as demais pelo botão “Mostrar mais opções”.

## Motores

- **CP-SAT** (`cp-sat`): modelo exato de programação por restrições. Recebe como dica um arranjo do heurístico livre e, para cada objetivo, o arranjo do objetivo anterior. O limite de tempo é 30 s por objetivo (5 s no mínimo, 1,5 s por cômodo).
- **Livre retangular** (`loose-rect`): tenta primeiro o modelo exato apertado (um arranjo apertado também é válido no modo livre), depois o modelo exato com espaços livres e, por fim, o heurístico livre. Costuma responder os três objetivos mesmo quando o `cp-sat` não fecha.
- **Guloso** (`greedy`): agrupa primeiro os cômodos com mais conexões e fatia a planta em cortes guilhotina. Se o encaixe falhar, usa a busca por posicionamento do motor livre.
- **Cortes no grafo** (`cut`): divide o grafo em grupos com poucas conexões e fatia a planta em cortes guilhotina. Se o encaixe falhar, usa a busca por posicionamento do motor livre.
- **Livre** (`loose`): posiciona cômodos um a um ao lado dos vizinhos e aceita formatos em L ou irregulares. Rejeita contornos com proporção acima de 3:1, a não ser que nada melhor exista. A caminhada desse motor também alimenta a dica dos motores exatos e as `alternatives` de todos os motores; cada planta guardada tem um grafo de contatos diferente.

Todos os motores devolvem o mesmo formato. Os motores retangulares exigem cobertura total de um retângulo; o motor livre retangular aceita um retângulo com espaços livres; o motor livre aceita qualquer contorno conexo sem vãos fechados. Todos passam pelo validador comum (`layout.mjs`), que rejeita sobreposições, paredes insuficientes e perímetro externo não atendido.

Instale as dependências com `npm install` e teste o motor com `npm test`. A suíte usa `casa_prado.json` — uma casa com corredor, jardim vazado e 12 cômodos — como caso complexo de validação dos motores. `npm run bench` roda todos os motores nesse caso e imprime tempo, status, área, caixa e validação por objetivo; use-o para comparar mudanças nos solvers. Qualquer arquivo de entrada ou envelope serve: `npm run bench -- outra_casa.json`.

## Publicação

O site é publicado no GitHub Pages pelo workflow `.github/workflows/pages.yml`: a cada push na `main` ele instala as dependências, copia a página e os arquivos do `cp-sat-wasm` (`browser` e `wasm`) para um artefato e publica em <https://marcelodaher.github.io/planta_helper/>. O import map do `index.html` é relativo, então a página funciona tanto na raiz quanto em um subdiretório. Para rodar localmente, sirva a raiz do projeto por HTTP (`npx serve` ou `python3 -m http.server`); `file://` não carrega os módulos.

## Decisões

- A planta é uma grade de 10 cm e todos os cômodos são retângulos alinhados a essa grade.
- Uma solução válida dos motores retangulares cobre completamente um único retângulo externo, sem sobreposição nem áreas mortas; o motor livre retangular aceita um retângulo com espaços livres; o motor livre aceita contornos conexos em L ou irregulares, sem vãos fechados.
- Fachadas nomeadas fixam aquele lado do cômodo à parede correspondente da casa. Como o nome tem significado geográfico, a planta nunca é girada na interface e o desenho mostra um indicador de norte; o motor exato também deixa de impor `largura >= altura` quando há fachadas em jogo.
- Todo cômodo regular informa área mínima, área máxima e lado mínimo. Duas flags são independentes: “Exige contato com a área externa” (`exterior`) obriga o cômodo a tocar o perímetro externo ou uma área vazada; “É área externa (vazado)” (`void`) marca um cômodo como área aberta, e os cômodos que tocam esse vazado passam a contar com área externa.
- A flag de contato com a área externa vem marcada para cômodos comuns e desmarcada para corredores e vazados.
- Conexões representam paredes compartilhadas de pelo menos 1 m (espaço para uma porta), são sempre bidirecionais, devem ser simétricas e são editadas por checkboxes. Conexões são opcionais: dois cômodos sem conexão podem se tocar, mas dois cômodos conectados precisam obrigatoriamente compartilhar uma parede.
- O corredor é um cômodo comum com a flag `"corridor": true`, área mínima/máxima e lado mínimo; por padrão não precisa tocar o exterior.
- Para a maior casa, o objetivo principal é maximizar a área total do retângulo externo; em empate, minimizar a área do corredor.
- Para a menor casa, o objetivo é minimizar a área total do retângulo externo; a área do corredor é o desempate.
- O motor usa OR-Tools CP-SAT em WebAssembly, em um worker no navegador, para produzir soluções viáveis ou ótimas comprovadas. O wasm é single-thread, então `numWorkers` não acelera a busca.
- O modelo exato fixa `largura >= altura` do retângulo externo: girar a planta não muda nada, e a restrição corta metade da simetria. A dica recebida é girada e deslocada para a origem antes de entrar no modelo.
- Os motores heurísticos nunca devolvem planta inválida: quando a árvore guilhotina não encaixa, eles caem na busca por posicionamento e o status passa a `loose`.
- Cinco motores selecionáveis na interface: CP-SAT (exato), livre retangular (exato com espaços livres), guloso, cortes no grafo e livre (formatos não retangulares); todos devolvem o mesmo formato e passam pelo validador adequado.
- O motor livre retangular devolve `bounds`, os limites do retângulo externo, para que a interface mostre também o espaço livre dentro da casa.
- A escolha do motor é salva no envelope JSON e restaurada ao abrir o arquivo.
- A lista de cômodos é reordenável por arraste; adicionar e editar usam o mesmo diálogo, com presets para cômodo e corredor.
- Arrastar um cômodo para “× Remover cômodo” o remove e limpa as conexões correspondentes.
- Cada cômodo tem uma cor escolhida no diálogo; ela é persistida no JSON e usada na visualização da planta.
- Salvar/abrir usa JSON versionado, e o CLI aceita tanto a entrada direta quanto o envelope salvo.
