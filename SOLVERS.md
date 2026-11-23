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
| `greedy` / `cut` | árvore guilhotina ou nada | árvore guilhotina ou busca por posicionamento (status `loose`) |
| Heurístico livre | primeira planta válida | idem, mas rejeita contorno acima de 3:1, salvo se não houver nada melhor |
| Medição | nenhuma | `npm run bench` (motor × objetivo: tempo, status, área, caixa, validação) |

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

Depois das mudanças, orçamento padrão (18 s por objetivo). **Medição anterior ao limite de proporção 3:1**:

| motor | menor | maior | corredor | tempo |
|---|---|---|---|---|
| `cp-sat` | 110,2 m² (10,8×10,2) | **182,0 m² ótimo** (14×13) | 163,8 m² | 45,6 s |
| `loose-rect` | 120,1 m² | 162,4 m² (24,6×6,6) | 153,7 m² | 18,1 s |
| `greedy` | 142,8 m² | 277,1 m² | 175,6 m² | 81 ms |
| `cut` | 142,8 m² | 277,1 m² | 175,6 m² | 120 ms |
| `loose` | 142,8 m² | 277,1 m² | 175,6 m² | 47 ms |

Com o orçamento curto da suíte de testes (3 s), `loose-rect` responde os três objetivos (exato apertado, exato solto ou heurístico); `cp-sat` é melhor esforço e às vezes não devolve nada, por isso o teste só exige layout válido de quem tem fallback.

Pendente: rodar `npm run bench` com o limite 3:1 já aplicado. A última rodada foi interrompida. Sondagens isoladas com o limite ligado deram `loose-rect` 109,0 / 178,1 / 167,7 m² e 54 s; `npm test` passa.

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
- O heurístico livre é guloso e não fecha lacunas: no `casa_prado` ele gasta 102 m² de cômodos dentro de uma caixa de 142,8 m² (o recorte em L da caixa não é área morta recuperável). Uma passada de compactação por deslizamento foi implementada e removida: os cômodos já estão encostados, então nenhum movimento é aceito.
- `loose-rect` pode gastar até o dobro do orçamento por objetivo: primeira tentativa apertada, depois a solta.
- Área comparada entre motores usa a caixa delimitadora (`bounds`), não a área útil; num layout em L a caixa inclui o recorte.

## Próximos passos

1. Rodar `npm run bench` com o limite 3:1 e registrar os números aqui.
2. Ver se `cp-sat` fecha os três objetivos com o orçamento de 30 s em 12 cômodos; hoje o corredor fica `feasible` e o menor também.
3. Aproximar o heurístico do exato no "menor": 142,8 m² contra 110,2 m². Ideias: escolher a forma do primeiro cômodo pela caixa final, ou colocar o corredor como faixa e pendurar os vizinhos nos dois lados.
4. Avaliar se o `greedy`/`cut` devem continuar existindo: com o fallback, os três heurísticos devolvem a mesma planta no `casa_prado`.
