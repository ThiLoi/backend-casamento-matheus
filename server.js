import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { db } from './db.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const mpConfig = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

console.log("Verificação do Token MP:", process.env.MP_ACCESS_TOKEN ? `Preenchido (Começa com: ${process.env.MP_ACCESS_TOKEN.substring(0, 15)}...)` : "VAZIO ❌");

// 1. RASTREADOR: Regista todos os pedidos que chegam ao servidor
app.use((req, res, next) => {
  console.log(`\n[${req.method}] Recebido no caminho: ${req.url}`);
  next();
});

app.post('/api/processar-pagamento', async (req, res) => {
  console.log("=== INÍCIO DO PROCESSAMENTO DO PAGAMENTO ===");
  console.log("📦 Dados recebidos do frontend:", JSON.stringify(req.body, null, 2));

  let client;
  try {
    console.log("🔄 A tentar ligar à base de dados Supabase...");
    client = await db.connect(); // Agora está protegido dentro do 'try'
    console.log("✅ Ligação à base de dados efetuada com sucesso!");

    const { paymentData, presenteNome, valor, nomeConvidado, mensagemNoivos } = req.body;

    if (!paymentData || !valor) {
      console.log("❌ Erro: Dados em falta no req.body!");
      return res.status(400).json({ message: "Dados do presente incompletos." });
    }

    const payment = new Payment(mpConfig);

    console.log("🔄 A enviar pedido para a API do Mercado Pago...");
    const mpResponse = await payment.create({
      body: {
        transaction_amount: Number(valor),
        token: paymentData?.token,
        description: `Presente: ${presenteNome}`,
        installments: Number(paymentData?.installments) || 1,
        payment_method_id: paymentData?.payment_method_id,
        issuer_id: paymentData?.issuer_id,
        payer: {
          email: paymentData?.payer?.email || 'convidado_casamento@teste.com',
          first_name: nomeConvidado || 'Convidado',
          identification: paymentData?.payer?.identification || undefined,
        },
      },
    });
    console.log("✅ Pagamento criado no MP! ID da transação:", mpResponse.id);

    console.log("🔄 A guardar registo do presente na base de dados...");
    await client.query(
      `INSERT INTO pedidos_presentes 
        (mercado_pago_id, presente_nome, nome_convidado, mensagem, valor, status_pagamento) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        String(mpResponse.id),
        presenteNome,
        nomeConvidado,
        mensagemNoivos,
        valor,
        mpResponse.status,
      ]
    );
    console.log("✅ Registo guardado com sucesso no Supabase!");

    return res.status(200).json(mpResponse);
  } catch (error) {
    console.error('❌ ERRO GRAVE NO BACKEND DETETADO:', error);
    // Se for erro do MP, enviamos para o frontend para saber qual foi o motivo
    const errorMessage = error.message || 'Erro interno do servidor';
    return res.status(400).json({ message: errorMessage, detalhes: error });
  } finally {
    if (client) {
      client.release();
      console.log("🔒 Ligação à base de dados encerrada.");
    }
  }
});

app.post('/api/webhooks/mercadopago', async (req, res) => {
  // Mantemos o webhook igual...
  const { type, data } = req.body;
  res.status(200).send('OK');

  if (type === 'payment' && data?.id) {
    try {
      const payment = new Payment(mpConfig);
      const paymentDetails = await payment.get({ id: data.id });
      const webhookClient = await db.connect();

      await webhookClient.query(
        `UPDATE pedidos_presentes SET status_pagamento = $1 WHERE mercado_pago_id = $2`,
        [paymentDetails.status, String(paymentDetails.id)]
      );

      if (paymentDetails.status === 'approved') {
        const result = await webhookClient.query(
          `SELECT presente_nome FROM pedidos_presentes WHERE mercado_pago_id = $1`,
          [String(paymentDetails.id)]
        );

        if (result.rows.length > 0) {
          await webhookClient.query(
            `INSERT INTO presentes (nome, comprado) VALUES ($1, TRUE) 
             ON CONFLICT (nome) DO UPDATE SET comprado = TRUE`,
            [result.rows[0].presente_nome]
          );
        }
      }
      webhookClient.release();
    } catch (error) {
      console.error('Erro no webhook:', error);
    }
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Backend a correr na porta ${PORT}`));