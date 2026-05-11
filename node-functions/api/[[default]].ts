import express from 'express'
import uploadRouter from './routes/upload'
import kvRouter from './routes/kv'

const app = express()
app.use(express.json())

app.use('/upload', uploadRouter)
app.use('/kv', kvRouter)

export default app
