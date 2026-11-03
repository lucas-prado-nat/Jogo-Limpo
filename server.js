
require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const app = express();
const PORT = 3000;

// Conexão com o banco de dados usando a variável de ambiente do Render/Supabase
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});
// Entregar os arquivos do site
app.use(express.static('public'));
// Permite o servidor ler dados enviados em formato JSON
app.use(express.json());
// Testar conexão com o banco
app.get('/teste', (req, res) => {
    res.send('O servidor está lendo o arquivo correto!');
});
app.get('/api/db-status', async (req, res) => {
    try {
        const resultado = await db.query('SELECT NOW()');

        res.json({
            conectado: true,
            mensagem: 'Banco de dados conectado!',
            horario: resultado.rows[0].now
        });

    } catch (erro) {
        console.error('Erro na conexão:', erro.message);

        res.status(500).json({
            conectado: false,
            mensagem: 'Não foi possível conectar ao banco.'
        });
    }
});

// Iniciar servidor

app.get('/api/disputas', async (req, res) => {
    try {
        const resultado = await db.query(
            'SELECT * FROM disputas ORDER BY criada_em DESC'
        );

        res.json(resultado.rows);

    } catch (erro) {
        console.error('Erro ao buscar disputas:', erro.message);

        res.status(500).json({
            mensagem: 'Não foi possível buscar as disputas.'
        });
    }
});
// Criar conta (nome único + senha). Começa com 1000 ouro.
app.post('/api/participantes', async (req, res) => {
    const { nome, senha } = req.body;

    if (typeof nome !== 'string' || typeof senha !== 'string') {
        return res.status(400).json({ mensagem: 'Informe o nome e a senha.' });
    }

    if (nome.trim().length < 3 || nome.trim().length > 30) {
        return res.status(400).json({ mensagem: 'O nome precisa ter entre 3 e 30 caracteres.' });
    }

    if (senha.length < 4) {
        return res.status(400).json({ mensagem: 'A senha precisa ter pelo menos 4 caracteres.' });
    }

    try {
        // Transforma a senha em hash antes de guardar
        const senhaHash = await bcrypt.hash(senha, 10);

        const resultado = await db.query(
            'INSERT INTO participantes (nome, senha_hash) VALUES ($1, $2) RETURNING id, nome, saldo',
            [nome.trim(), senhaHash]
        );

        res.json(resultado.rows[0]);

    } catch (erro) {
        // 23505 = nome já existe (violou a regra de nome único)
        if (erro.code === '23505') {
            return res.status(409).json({ mensagem: 'Esse nome já está em uso. Se a conta é sua, clique em Entrar.' });
        }

        console.error('Erro ao criar conta:', erro.message);
        res.status(500).json({ mensagem: 'Não foi possível criar a conta.' });
    }
});

// Entrar numa conta que já existe
app.post('/api/entrar', async (req, res) => {
    const { nome, senha } = req.body;

    if (typeof nome !== 'string' || typeof senha !== 'string') {
        return res.status(400).json({ mensagem: 'Informe o nome e a senha.' });
    }

    try {
        const resultado = await db.query(
            'SELECT id, nome, saldo, senha_hash FROM participantes WHERE LOWER(nome) = LOWER($1)',
            [nome.trim()]
        );

        // A mesma mensagem para "nome errado" e "senha errada"
        const erroLogin = { mensagem: 'Nome ou senha incorretos.' };

        if (resultado.rows.length === 0) {
            return res.status(401).json(erroLogin);
        }

        const jogador = resultado.rows[0];

        // Compara a senha digitada com o hash guardado
        const senhaCorreta = await bcrypt.compare(senha, jogador.senha_hash);

        if (!senhaCorreta) {
            return res.status(401).json(erroLogin);
        }

        res.json({ id: jogador.id, nome: jogador.nome, saldo: jogador.saldo });

    } catch (erro) {
        console.error('Erro ao entrar:', erro.message);
        res.status(500).json({ mensagem: 'Não foi possível entrar.' });
    }
});
// Consultar um participante (para ver o saldo)
app.get('/api/participantes/:id', async (req, res) => {
    try {
        const resultado = await db.query(
            'SELECT id, nome, saldo FROM participantes WHERE id = $1',
            [req.params.id]
        );

        if (resultado.rows.length === 0) {
            return res.status(404).json({ mensagem: 'Participante não encontrado.' });
        }

        res.json(resultado.rows[0]);
    } catch (erro) {
        console.error('Erro ao buscar participante:', erro.message);
        res.status(500).json({ mensagem: 'Erro ao buscar participante.' });
    }
});

// Fazer uma aposta com créditos fictícios
app.post('/api/disputas/:id/apostas', async (req, res) => {
    const disputaId = req.params.id;
    const { participante_id, opcao, valor } = req.body;

    // Validações básicas
    if (opcao !== 'A' && opcao !== 'B') {
        return res.status(400).json({ mensagem: 'A opção deve ser A ou B.' });
    }

    const VALORES_PERMITIDOS = [10, 50, 100, 500];

    if (!VALORES_PERMITIDOS.includes(valor)) {
        return res.status(400).json({ mensagem: 'A aposta deve ser de 10, 50, 100 ou 500 ouro.' });
    }

    const client = await db.connect();

    try {
        // BEGIN: ou tudo dá certo, ou nada é salvo
        await client.query('BEGIN');

        const disputa = await client.query(
            'SELECT status FROM disputas WHERE id = $1',
            [disputaId]
        );

        if (disputa.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ mensagem: 'Disputa não encontrada.' });
        }

        if (disputa.rows[0].status !== 'aberta') {
            await client.query('ROLLBACK');
            return res.status(400).json({ mensagem: 'Esta disputa não está aberta.' });
        }

        // Desconta o valor do saldo, só se houver saldo suficiente
        const debito = await client.query(
            'UPDATE participantes SET saldo = saldo - $1 WHERE id = $2 AND saldo >= $1 RETURNING saldo',
            [valor, participante_id]
        );

        if (debito.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ mensagem: 'Saldo insuficiente ou participante não existe.' });
        }

        await client.query(
            'INSERT INTO apostas (disputa_id, participante_id, opcao, valor) VALUES ($1, $2, $3, $4)',
            [disputaId, participante_id, opcao, valor]
        );

        await client.query('COMMIT');

        res.json({
            mensagem: 'Aposta registrada!',
            saldo_restante: debito.rows[0].saldo
        });

    } catch (erro) {
        await client.query('ROLLBACK');
               // 23505 = esta pessoa já apostou nesta disputa
        if (erro.code === '23505') {
            return res.status(400).json({ mensagem: 'Você já apostou nesta disputa.' });
        }
        console.error('Erro ao apostar:', erro.message);
        res.status(500).json({ mensagem: 'Não foi possível registrar a aposta.' });
    } finally {
        client.release();
    }
});
// Só deixa passar quem enviar a senha correta do administrador
function exigirAdmin(req, res, next) {
    const senha = req.headers['x-admin-senha'];

    if (!process.env.ADMIN_SENHA || senha !== process.env.ADMIN_SENHA) {
        return res.status(401).json({ mensagem: 'Acesso negado.' });
    }

    next();
}
// Encerrar a disputa com o resultado oficial e pagar quem acertou
app.post('/api/admin/disputas/:id/encerrar', exigirAdmin, async (req, res) => {
    const disputaId = req.params.id;
    const { resultado } = req.body;

    if (resultado !== 'A' && resultado !== 'B') {
        return res.status(400).json({ mensagem: 'O resultado deve ser A ou B.' });
    }

    const MARGEM_CASA = 0.5; // a casa fica com 50%

    const client = await db.connect();

    try {
        await client.query('BEGIN');

        // FOR UPDATE impede que a mesma disputa seja encerrada duas vezes ao mesmo tempo
        const disputa = await client.query(
            'SELECT status FROM disputas WHERE id = $1 FOR UPDATE',
            [disputaId]
        );

        if (disputa.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ mensagem: 'Disputa não encontrada.' });
        }

        if (disputa.rows[0].status !== 'aberta') {
            await client.query('ROLLBACK');
            return res.status(400).json({ mensagem: 'Esta disputa não está aberta.' });
        }

        const apostas = await client.query(
            'SELECT id, participante_id, opcao, valor FROM apostas WHERE disputa_id = $1',
            [disputaId]
        );

        // Soma o total apostado e o total apostado pelos vencedores
        let totalApostado = 0;
        let totalVencedores = 0;

        for (const aposta of apostas.rows) {
            totalApostado += aposta.valor;
            if (aposta.opcao === resultado) {
                totalVencedores += aposta.valor;
            }
        }

        // O que sobra para os vencedores depois da parte da casa
        const totalParaVencedores = Math.floor(totalApostado * (1 - MARGEM_CASA));

        let totalPago = 0;

        for (const aposta of apostas.rows) {
            let premio = 0;

            if (aposta.opcao === resultado) {
                premio = Math.floor(aposta.valor * totalParaVencedores / totalVencedores);
            }

            totalPago += premio;

            await client.query(
                'UPDATE apostas SET premio = $1 WHERE id = $2',
                [premio, aposta.id]
            );

            if (premio > 0) {
                await client.query(
                    'UPDATE participantes SET saldo = saldo + $1 WHERE id = $2',
                    [premio, aposta.participante_id]
                );
            }
        }

        // Tudo que não foi pago aos vencedores fica com a casa
        const valorCasa = totalApostado - totalPago;

        await client.query(
            "UPDATE disputas SET status = 'encerrada', resultado = $1, encerrada_em = NOW(), valor_casa = $2 WHERE id = $3",
            [resultado, valorCasa, disputaId]
        );

        await client.query('COMMIT');

        res.json({
            mensagem: 'Disputa encerrada!',
            resultado: resultado,
            total_apostado: totalApostado,
            total_pago: totalPago,
            valor_casa: valorCasa
        });

    } catch (erro) {
        await client.query('ROLLBACK');
        console.error('Erro ao encerrar disputa:', erro.message);
        res.status(500).json({ mensagem: 'Não foi possível encerrar a disputa.' });
    } finally {
        client.release();
    }
});

// Cancelar a disputa (empate, problema etc.) e devolver o ouro apostado
app.post('/api/admin/disputas/:id/cancelar', exigirAdmin, async (req, res) => {
    const disputaId = req.params.id;

    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const disputa = await client.query(
            'SELECT status FROM disputas WHERE id = $1 FOR UPDATE',
            [disputaId]
        );

        if (disputa.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ mensagem: 'Disputa não encontrada.' });
        }

        if (disputa.rows[0].status !== 'aberta') {
            await client.query('ROLLBACK');
            return res.status(400).json({ mensagem: 'Esta disputa não está aberta.' });
        }

        const apostas = await client.query(
            'SELECT id, participante_id, valor FROM apostas WHERE disputa_id = $1',
            [disputaId]
        );

        // Devolve a cada participante o valor que ele apostou
        for (const aposta of apostas.rows) {
            await client.query(
                'UPDATE participantes SET saldo = saldo + $1 WHERE id = $2',
                [aposta.valor, aposta.participante_id]
            );

            await client.query(
                'UPDATE apostas SET premio = $1 WHERE id = $2',
                [aposta.valor, aposta.id]
            );
        }

        await client.query(
            "UPDATE disputas SET status = 'cancelada', encerrada_em = NOW(), valor_casa = 0 WHERE id = $1",
            [disputaId]
        );

        await client.query('COMMIT');

        res.json({
            mensagem: 'Disputa cancelada. O ouro foi devolvido.',
            apostas_devolvidas: apostas.rows.length
        });

    } catch (erro) {
        await client.query('ROLLBACK');
        console.error('Erro ao cancelar disputa:', erro.message);
        res.status(500).json({ mensagem: 'Não foi possível cancelar a disputa.' });
    } finally {
        client.release();
    }
});
// Recompensa diária: 1000 de ouro, uma vez por dia
app.post('/api/participantes/:id/recompensa', async (req, res) => {
    const participanteId = req.params.id;

    try {
        // Só atualiza se o último recebimento foi antes de hoje
        const resultado = await db.query(
            `UPDATE participantes
             SET saldo = saldo + 1000,
                 ultima_recompensa = timezone('America/Sao_Paulo', now())::date
             WHERE id = $1
               AND ultima_recompensa < timezone('America/Sao_Paulo', now())::date
             RETURNING saldo`,
            [participanteId]
        );

        if (resultado.rows.length === 0) {
            // Descobre o motivo: participante inexistente ou recompensa já recebida
            const existe = await db.query(
                'SELECT id FROM participantes WHERE id = $1',
                [participanteId]
            );

            if (existe.rows.length === 0) {
                return res.status(404).json({ mensagem: 'Participante não encontrado.' });
            }

            return res.status(400).json({ mensagem: 'A recompensa de hoje já foi recebida. Volte amanhã!' });
        }

        res.json({
            mensagem: 'Recompensa diária recebida: +1000 ouro!',
            saldo: resultado.rows[0].saldo
        });

    } catch (erro) {
        console.error('Erro na recompensa diária:', erro.message);
        res.status(500).json({ mensagem: 'Não foi possível entregar a recompensa.' });
    }
});
// Confere se a senha do administrador está correta
app.post('/api/admin/verificar', exigirAdmin, (req, res) => {
    res.json({ ok: true });
});

// Lista todas as disputas com o total apostado (visão do administrador)
app.get('/api/admin/disputas', exigirAdmin, async (req, res) => {
    try {
        const resultado = await db.query(
            `SELECT d.*,
                    COUNT(a.id)::int AS qtd_apostas,
                    COALESCE(SUM(a.valor), 0)::int AS total_apostado
             FROM disputas d
             LEFT JOIN apostas a ON a.disputa_id = d.id
             GROUP BY d.id
             ORDER BY d.criada_em DESC`
        );

        res.json(resultado.rows);

    } catch (erro) {
        console.error('Erro ao listar disputas (admin):', erro.message);
        res.status(500).json({ mensagem: 'Não foi possível listar as disputas.' });
    }
});

// Criar uma disputa nova (já nasce aberta)
app.post('/api/admin/disputas', exigirAdmin, async (req, res) => {
    const { titulo, descricao, opcao_a, opcao_b } = req.body;

    const campos = [titulo, opcao_a, opcao_b];
    if (campos.some(campo => typeof campo !== 'string' || campo.trim() === '')) {
        return res.status(400).json({ mensagem: 'Preencha o título e as duas opções.' });
    }

    try {
        const resultado = await db.query(
            `INSERT INTO disputas (titulo, descricao, opcao_a, opcao_b, status)
             VALUES ($1, $2, $3, $4, 'aberta')
             RETURNING *`,
            [
                titulo.trim(),
                typeof descricao === 'string' ? descricao.trim() : '',
                opcao_a.trim(),
                opcao_b.trim()
            ]
        );

        res.json(resultado.rows[0]);

    } catch (erro) {
        console.error('Erro ao criar disputa:', erro.message);
        res.status(500).json({ mensagem: 'Não foi possível criar a disputa.' });
    }
});
// Apagar uma disputa finalizada e as apostas dela
app.delete('/api/admin/disputas/:id', exigirAdmin, async (req, res) => {
    const disputaId = req.params.id;

    const client = await db.connect();

    try {
        await client.query('BEGIN');

        const disputa = await client.query(
            'SELECT status FROM disputas WHERE id = $1 FOR UPDATE',
            [disputaId]
        );

        if (disputa.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ mensagem: 'Disputa não encontrada.' });
        }

        // Disputa aberta ainda tem ouro em jogo: não pode ser apagada
        if (disputa.rows[0].status === 'aberta') {
            await client.query('ROLLBACK');
            return res.status(400).json({ mensagem: 'Só é possível apagar disputas encerradas ou canceladas.' });
        }

        // As apostas precisam ser apagadas antes da disputa
        await client.query('DELETE FROM apostas WHERE disputa_id = $1', [disputaId]);
        await client.query('DELETE FROM disputas WHERE id = $1', [disputaId]);

        await client.query('COMMIT');

        res.json({ mensagem: 'Disputa e apostas apagadas.' });

    } catch (erro) {
        await client.query('ROLLBACK');
        console.error('Erro ao apagar disputa:', erro.message);
        res.status(500).json({ mensagem: 'Não foi possível apagar a disputa.' });
    } finally {
        client.release();
    }
});

// Apagar todas as disputas finalizadas (encerradas ou canceladas) e suas apostas
app.post('/api/admin/limpar-finalizadas', exigirAdmin, async (req, res) => {
    const client = await db.connect();

    try {
        await client.query('BEGIN');

        await client.query(
            `DELETE FROM apostas
             WHERE disputa_id IN (SELECT id FROM disputas WHERE status <> 'aberta')`
        );

        const apagadas = await client.query(
            `DELETE FROM disputas WHERE status <> 'aberta' RETURNING id`
        );

        await client.query('COMMIT');

        res.json({ mensagem: apagadas.rowCount + ' disputa(s) finalizada(s) apagada(s).' });

    } catch (erro) {
        await client.query('ROLLBACK');
        console.error('Erro ao limpar disputas:', erro.message);
        res.status(500).json({ mensagem: 'Não foi possível apagar as disputas.' });
    } finally {
        client.release();
    }
});
app.listen(PORT, () => {
    console.log(`Jogo Limpo rodando em http://localhost:${PORT}`);
});
