import { getKindeServerSession } from '@kinde-oss/kinde-auth-nextjs/server'
import { privateProcedure, publicProcedure, router } from './trpc';
import { TRPCError } from '@trpc/server';
import { db } from '@/db';
import { z } from 'zod'
import { UTApi } from "uploadthing/server"
import { getPineconeClient } from '@/lib/pinecone'
import { INFINITE_QUERY_LIMIT } from '@/config/infinite-query'


export const appRouter = router({
  authCallback: publicProcedure.query(async () => {
    const {getUser} = getKindeServerSession();
    const user: any = await getUser();

    if (!user.id || !user.email)
      throw new TRPCError({ code: 'UNAUTHORIZED' })

    // check if the user is in the database
    const dbUser = await db.user.findFirst({
      where: {
        id: user.id,
      },
    })

    if (!dbUser) {
      // create user in db
      await db.user.create({
        data: {
          id: user.id,
          email: user.email,
        },
      })
    }

    return { success: true }
  }),

  getUserFiles: privateProcedure.query(async ({ ctx }) => {
    const { userId } = ctx

    return await db.file.findMany({
      where: {
        userId,
      },
    })
  }),

  deleteFile: privateProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { userId } = ctx

      const file = await db.file.findFirst({
        where: {
          id: input.id,
          userId,
        },
      })

      if (!file) throw new TRPCError({ code: 'NOT_FOUND' })

      await db.file.delete({
        where: {
          id: input.id,
        },
      })


      // Delete file from uploadthing

      const utapi = new UTApi();

      await utapi.deleteFiles(file.key);


      // Delete Index namespace from pinecone

      const pinecone = await getPineconeClient()
      const pineconeIndex = pinecone.Index('papertalk')

      const namespace = file.id

      await pineconeIndex.delete1({
        deleteAll: true,
        namespace,
      })

      return file
    }),

    getFileMessages: privateProcedure
      .input(
        z.object({
          limit: z.number().min(1).max(100).nullish(),
          cursor: z.string().nullish(),
          fileId: z.string(),
        })
      )
      .query(async ({ ctx, input }) => {
        const { userId } = ctx
        const { fileId, cursor } = input
        const limit = input.limit ?? INFINITE_QUERY_LIMIT

        const file = await db.file.findFirst({
          where: {
            id: fileId,
            userId,
          },
        })

        if (!file) throw new TRPCError({ code: 'NOT_FOUND' })

        const messages = await db.message.findMany({
          take: limit + 1,
          where: {
            fileId,
          },
          orderBy: {
            createdAt: 'desc',
          },
          cursor: cursor ? { id: cursor } : undefined,
          select: {
            id: true,
            isUserMessage: true,
            createdAt: true,
            text: true,
          },
        })

        let nextCursor: typeof cursor | undefined = undefined
        if (messages.length > limit) {
          const nextItem = messages.pop()
          nextCursor = nextItem?.id
        }

        return {
          messages,
          nextCursor,
        }
      }),
  
    getFileUploadStatus: privateProcedure
    .input(z.object({ fileId: z.string() }))
    .query(async ({ input, ctx }) => {
      const file = await db.file.findFirst({
        where: {
          id: input.fileId,
          userId: ctx.userId,
        },
      })

      if (!file) return { status: 'PENDING' as const }

      return { status: file.uploadStatus }
    }),

  getFile: privateProcedure
    .input(z.object({ key: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { userId } = ctx

      const file = await db.file.findFirst({
        where: {
          key: input.key,
          userId,
        },
      })

      if (!file) throw new TRPCError({ code: 'NOT_FOUND' })

      return file
    }),

});


export type AppRouter = typeof appRouter;