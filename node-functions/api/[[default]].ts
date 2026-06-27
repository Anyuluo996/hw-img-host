import express from 'express'
import uploadRouter from './routes/upload'
import authRouter from './routes/auth'
import deleteRouter from './routes/delete'

const app = express()
app.use(express.json())
app.use('/auth', authRouter)
app.use('/upload', uploadRouter)
app.use('/delete', deleteRouter)

export default app
