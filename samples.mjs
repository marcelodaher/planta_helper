export const samples = [
  {
    id: "compacta",
    title: "Casa compacta",
    description: "Sala, quarto, cozinha, banheiro e lavanderia com áreas ajustáveis.",
    input: {
      rooms: [
        { name: "sala", minArea: 12, maxArea: 16, minSide: 2.4, exterior: true, links: ["quarto", "cozinha", "banheiro"] },
        { name: "quarto", minArea: 9, maxArea: 12, minSide: 2.4, exterior: true, links: ["sala"] },
        { name: "cozinha", minArea: 6, maxArea: 9, minSide: 1.8, exterior: true, links: ["sala", "lavanderia"] },
        { name: "banheiro", minArea: 2.5, maxArea: 4, minSide: 1.2, exterior: true, links: ["sala"] },
        { name: "lavanderia", minArea: 3, maxArea: 5, minSide: 1.5, exterior: true, links: ["cozinha"] },
      ],
    },
  },
  {
    id: "suite",
    title: "Suíte com closet",
    description: "Quarto, closet e banheiro com acesso direto entre si.",
    input: {
      rooms: [
        { name: "quarto1", minArea: 12, maxArea: 16, minSide: 2.4, exterior: true, links: ["closet1", "banheiro1"] },
        { name: "closet1", minArea: 3, maxArea: 5, minSide: 1.2, exterior: true, links: ["quarto1"] },
        { name: "banheiro1", minArea: 4, maxArea: 8, minSide: 1.5, exterior: true, links: ["quarto1"] },
      ],
    },
  },
];
