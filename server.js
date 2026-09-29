import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { db } from './db.js';
import { PRODUTOS } from './produtos.js';

dotenv.config();

const app = express();

// Restringe o CORS ao domínio do site em produção.
// Define FRONTEND_URL no .env (ex: https://o-teu-site.com). Em dev, sem a
// variável definida, aceita qualquer origem para não travar o localhost.
app.use(
  cors({
    origin: process.env.FRONTEND_URL || true,
  }),
);
app.use(express.json());

// Inicializa o Mercado Pago com a chave privada
const mpConfig = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

// Rota para processar o pagamento com segurança
app.post('/api/processar-pagamento', async (req, res) => {
  const { paymentData, produtoId, nomeConvidado, mensagemNoivos } = req.body;

  // O preço NUNCA vem do cliente. É sempre resolvido aqui, a partir do
  // catálogo do servidor, usando apenas o id do presente escolhido.
  const produto = PRODUTOS[produtoId];
  if (!produto) {
    return res.status(400).json({ message: 'Presente inválido.' });
  }

  const client = await db.connect();

  try {
    const payment = new Payment(mpConfig);

    // Chave de idempotência: evita que um retry de rede crie um segundo
    // pagamento cobrado ao convidado.
    const idempotencyKey = crypto.randomUUID();

    // Cria a intenção de pagamento no Mercado Pago protegendo contra campos nulos
    const mpResponse = await payment.create(
      {
        body: {
          transaction_amount: produto.preco,
          token: paymentData?.token, // Protegido para suportar Pix e Cartão
          description: `Presente: ${produto.nome}`,
          installments: Number(paymentData?.installments) || 1,
          payment_method_id: paymentData?.payment_method_id,
          issuer_id: paymentData?.issuer_id,
          payer: {
            email: paymentData?.payer?.email || 'convidado_casamento@teste.com',
            first_name: nomeConvidado || 'Convidado',
            identification: paymentData?.payer?.identification || undefined,
          },
        },
      },
      { idempotencyKey },
    );

    // Guarda na base de dados a mensagem e o estado inicial.
    // presente_nome e valor vêm do catálogo do servidor, não do req.body.
    await client.query(
      `INSERT INTO pedidos_presentes 
        (mercado_pago_id, presente_nome, nome_convidado, mensagem, valor, status_pagamento) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        String(mpResponse.id),
        produto.nome,
        nomeConvidado,
        mensagemNoivos,
        produto.preco,
        mpResponse.status,
      ]
    );

    return res.status(200).json(mpResponse);
  } catch (error) {
    console.error('Erro no pagamento:', error);
    return res.status(500).json({ message: 'Erro interno', error: error.message });
  } finally {
    client.release();
  }
});

// Rota de Webhook para atualizar o estado do pagamento e marcar o presente como comprado
app.post('/api/webhooks/mercadopago', async (req, res) => {
  const { type, data } = req.body;
  res.status(200).send('OK');

  if (type === 'payment' && data?.id) {
    try {
      const payment = new Payment(mpConfig);
      const paymentDetails = await payment.get({ id: data.id });
      const client = await db.connect();

      await client.query(
        `UPDATE pedidos_presentes SET status_pagamento = $1 WHERE mercado_pago_id = $2`,
        [paymentDetails.status, String(paymentDetails.id)]
      );

      if (paymentDetails.status === 'approved') {
        const result = await client.query(
          `SELECT presente_nome FROM pedidos_presentes WHERE mercado_pago_id = $1`,
          [String(paymentDetails.id)]
        );

        if (result.rows.length > 0) {
          await client.query(
            `INSERT INTO presentes (nome, comprado) VALUES ($1, TRUE) 
             ON CONFLICT (nome) DO UPDATE SET comprado = TRUE`,
            [result.rows[0].presente_nome]
          );
        }
      }
      client.release();
    } catch (error) {
      console.error('Erro no webhook:', error);
    }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend a correr na porta ${PORT}`));
