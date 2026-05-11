import express from 'express'
import uploadRouter from './routes/upload'
import kvRouter from './routes/kv'
import authRouter from './routes/auth'

const app = express()
app.use(express.json())

app.use('/auth', authRouter)
app.use('/upload', uploadRouter)
app.use('/kv', kvRouter)

export default app
