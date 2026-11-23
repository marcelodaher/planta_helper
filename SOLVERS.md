# Estado dos solvers

Registro do estado atual dos motores de planta depois da rodada de melhorias.

## O que mudou

| Área | Antes | Agora |
|---|---|---|
| Semente do CP-SAT | modelo partia do zero | layout do heurístico livre entra como `model.addHint` (girado e deslocado para a origem); o layout do objetivo anterior é a segunda semente |
| Simetria | livre | `largura >= altura` (girar a planta é equivalente) |
| Proporção | livre | `largura <= 3 × altura`; sem isso "maior área" virava uma casa de 4,5:1 |
| Tempo por objetivo | 5 s fixos | `min(30, max(5, 1,5 × cômodos))`; 12 cômodos → 18 s; `PLANTA_SOLVE_SECONDS` sobrepõe |
| `loose-rect` | só o modelo exato solto | exato apertado → exato solto → heurístico livre |
| Motores | cinco (dois de árvore guilhotina) | três: `cp-sat`, `loose-rect` e `loose`; `greedy` e `cut` removidos porque nunca venceram o livre (mesma planta no `casa_prado`) |
| Heurístico livre | primeira planta válida | caminhada de 150 ms por objetivo, uma planta por grafo de contatos, ranqueada pelo custo do objetivo; contorno acima de 3:1 só como último recurso |
| Medição | nenhuma | `npm run bench` (motor × objetivo: tempo, status, área, caixa, validação) |
| Alternativas | só as 3 melhores | a caminhada do heurístico livre guarda a melhor planta por grafo de contatos; a página revela as demais em lotes |

Decisões e detalhes no `README.md` ("Motores" e "Decisões"). Este arquivo guarda os números.

## Números

Caso `casa_prado.json`: 12 cômodos, corredor com 5 portas, jardim vazado. Limites: Σmin = 101 m², Σmax = 182 m².

Antes das mudanças (limite de 5 s por objetivo):

| motor | menor | maior | corredor | tempo |
|---|---|---|---|---|
| `cp-sat` | 135,3 m² | 176,7 m² | sem planta | 15,1 s |
| `loose-rect` | 142,8 m² (heurístico) | 212,3 m² (heurístico) | 134,5 m² | 12,1 s |
| `greedy` | falhou | falhou | falhou | 3 ms |
| `cut` | falhou | falhou | falhou | 42 ms |
| `loose` | 142,8 m² | 212,3 m² (7,5×28,3 m) | 175,6 m² | 42 ms |

Depois das mudanças, orçamento padrão (18 s por objetivo), com o limite de proporção 3:1, as fachadas e a caminhada ranqueada por custo:

| motor | menor | maior | corredor | tempo |
|---|---|---|---|---|
| `cp-sat` | 104,7 m² (11,5×9,1) | **182,0 m² ótimo** (14×13) | 163,8 m² | 47,8 s |
| `loose-rect` | 105,7 m² | **182,0 m² ótimo** | 168,3 m² | 54,4 s |
| `loose` | 138,6 m² | 269,1 m² (11,5×23,4) | 175,6 m² | 0,8 s |

A semente ranqueada (em vez da primeira planta válida) melhorou os exatos: `cp-sat` fechou o "maior" como ótimo e desceu o "menor" de 106,1 para 104,7 m². Os heurísticos pagam a caminhada de alternativas: 0,8–0,9 s por geração, contra 44–92 ms antes. Cada geração devolve 8–12 alternativas no `casa_prado`, uma por grafo de contatos, já sem as topologias das três opções.

Com o orçamento curto da suíte de testes (3 s), `loose-rect` responde os três objetivos (exato apertado, exato solto ou heurístico); `cp-sat` é melhor esforço e às vezes não devolve nada, por isso o teste só exige layout válido de quem tem fallback.

## Como reproduzir

```sh
npm install
npm test                                  # correção, ~30 s, cada motor no casa_prado
npm run bench                             # qualidade e tempo, orçamento padrão
npm run bench -- outra_casa.json          # qualquer entrada ou envelope salvo
PLANTA_SOLVE_SECONDS=5 npm run bench      # orçamento curto
```

## Armadilhas conhecidas

- O wasm do CP-SAT é single-thread: `numWorkers` não acelera nada (medido com 1, 4 e 8).
- O executor `inline` quebra no Node; o motor usa `executor: "worker"`.
- O limite por objetivo é de parede: a mesma entrada pode devolver incumbentes diferentes entre execuções. O heurístico é determinístico; o exato não é.
- O heurístico livre é guloso e não fecha lacunas: no `casa_prado` ele gasta 102 m² de cômodos dentro de uma caixa de 138,6 m² (o recorte em L da caixa não é área morta recuperável). Uma passada de compactação por deslizamento foi implementada e removida: os cômodos já estão encostados, então nenhum movimento é aceito.
- A pool do CP-SAT não serve como fonte de alternativas: `fillAdditionalSolutionsInResponse` sozinho devolve 1 solução; com `keepAllFeasibleSolutionsInPresolve` ela enche, mas mexe no resultado do objetivo (num A/B o "maior" caiu de 179,6 para 163,6 m²), e as 8 soluções ainda viram só 1–3 grafos de contatos. As alternativas vêm da caminhada heurística.
- O grafo de contatos ignora posição e tamanho: duas plantas com a mesma topologia e áreas diferentes viram uma só; fica a de menor custo no objetivo. Um contato de 10 cm não conta como aresta (`MIN_DOOR` = 1 m).
- `loose-rect` pode gastar até o dobro do orçamento por objetivo: primeira tentativa apertada, depois a solta.
- Área comparada entre motores usa a caixa delimitadora (`bounds`), não a área útil; num layout em L a caixa inclui o recorte.

## Próximos passos

1. `cp-sat` ainda não fecha "menor" e "corredor" no orçamento padrão (104,7 e 163,8 m², ambos `feasible`); com 30 s o "maior" vira ótimo e os outros dois seguem `feasible`. Apertar os domínios do modelo: no apertado `W·H = Σárea ≤ Σmax`, então `H ≤ √Σmax` e `W ≤ √(3·Σmax)`, contra `Σmax` para todos hoje; limitar largura e altura de cada cômodo por `maxArea/minSide`; ordenar cômodos com limites idênticos (ex.: `sala_jantar` e `sala_tv`).
2. Aproximar o heurístico do exato no "menor": 138,6 m² contra 104,7 m². A caminhada já ranqueia por custo; ideias: escolher a forma do primeiro cômodo pela caixa final, ou colocar o corredor como faixa e pendurar os vizinhos nos dois lados.
3. As alternativas custam 0,8–0,9 s nos heurísticos (a caminhada de 150 ms por objetivo). Se o atraso incomodar, mover a coleta para o botão, com uma segunda chamada e a geração inicial de volta aos ~44 ms.
